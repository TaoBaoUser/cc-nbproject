import { useEffect, useState } from 'react';
import { ccnb } from '../ccnb';
import type { PreviewResult, TakeoverActionResult } from '../types';

interface Props {
  onClose: () => void;
  /** 由 useClaudeStatus 提供：走同一条路径，接管成功后侧边栏会自动刷新。 */
  onTakeover: () => Promise<TakeoverActionResult>;
}

/** 接管成功后展示的内容（原版是直接 replaceChildren 换掉整个模态框） */
interface DoneState {
  backupPath?: string | null;
  createdBackup?: boolean;
}

export default function SetupModal({ onClose, onTakeover }: Props) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [writing, setWriting] = useState(false);
  const [done, setDone] = useState<DoneState | null>(null);

  useEffect(() => {
    let cancelled = false;
    ccnb()
      .previewClaudeSettings()
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConfirm = async () => {
    setWriting(true);
    setError('');
    try {
      const result = await onTakeover();
      // 接管用的是「不抛错、返回 ok:false」的约定 —— 主进程要区分「准入不通过」
      // 与「写入失败」两种原因并各自给出可读文案，扔异常就只剩一句 message 了。
      // 因此这里不能只靠 catch，必须显式判 ok。
      if (!result.ok) {
        setError(result.reason || '接管失败');
        setWriting(false);
        return;
      }
      setDone({ backupPath: result.backupPath, createdBackup: result.createdBackup });
    } catch (err) {
      setError((err as Error).message);
      setWriting(false);
    }
  };

  if (loadError) {
    return (
      <div className="modal">
        <h2>无法读取 Claude Code 配置</h2>
        <p className="modal-sub">{loadError}</p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  // 代理没起来（端口被占）或还没激活供应商时，主进程拒绝出预览。
  // 与其展示一份注定写不进去的 diff，不如直接说清为什么。
  if (preview && !preview.ok) {
    return (
      <div className="modal">
        <h2>暂时无法接管</h2>
        <p className="modal-sub">{preview.reason}</p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="modal">
        <h2>已接管</h2>
        <p className="modal-sub">请重启 Claude Code 以加载新的配置。</p>
        <div className="notice notice-info">
          {'接管之后：\n' +
            '· 本工具每次启动都会自动接管，不必再点一次\n' +
            '· 每次退出都会自动还原成接管前的样子\n' +
            '· 想彻底停用，在侧边栏点「断开接入」'}
        </div>
        <div className="notice notice-info">
          {done.backupPath
            ? `${done.createdBackup ? '原配置已备份至' : '沿用此前创建的备份'}：\n${done.backupPath}`
            : '原文件不存在，未产生备份。'}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            好
          </button>
        </div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="modal">
        <h2>配置 Claude Code</h2>
        <p className="modal-sub">正在读取配置…</p>
      </div>
    );
  }

  return (
    <div className="modal">
      <h2>接管 Claude Code</h2>
      <p className="modal-sub">
        将 Claude Code 的 Anthropic 端点指向本工具的本地代理。这是本工具唯一会修改你现有文件的操作。
      </p>

      {/* 「一次授权、之后自动」是本页最重要的一句话：用户点下确认前必须知道
          自己授权的不只是这一次写入，而是以后每次启动的自动写入。 */}
      <div className="notice notice-info">
        {'这是一次性授权：确认之后，本工具每次启动会自动接管、退出时自动还原，\n' +
          '不再逐次询问。随时可以在侧边栏「断开接入」停用。'}
      </div>

      {/* PRD 第 4 节列出的「本方案最大的残余风险」：接管后不再打开本应用，
          Claude Code 会永久指向一个没人监听的端口。这条必须在确认前说清楚，
          因为它是用户唯一无法从界面上自行察觉的失败。 */}
      <div className="notice notice-warn">
        {'如果你以后不再打算打开本应用，请先点「断开接入」——\n' +
          '否则 Claude Code 会一直指向一个没有运行的代理，从而无法使用。'}
      </div>

      {/* 企业强制配置会覆盖一切用户级设置，这种失败是静默的，必须显式告警 */}
      {preview.managedConflict && (
        <div className="notice notice-warn">
          {`检测到企业级强制配置：${preview.managedConflict.path}\n` +
            `其中已下发 ANTHROPIC_BASE_URL（${preview.managedConflict.baseUrl}）。` +
            `它的优先级高于用户配置，本工具将无法生效。`}
        </div>
      )}

      <div className="notice notice-info">
        {preview.exists
          ? `目标文件：${preview.settingsPath}\n` +
            (preview.willBackup
              ? '写入前会自动备份一份（文件名带时间戳，成功后会告诉你具体路径）'
              : '此前已备份过，本次不再重复备份')
          : `目标文件尚不存在，将被创建：${preview.settingsPath}`}
      </div>

      {/* 改动对照表：让用户在点确认前，逐项看清到底改了什么 */}
      <table className="diff-table">
        <thead>
          <tr>
            <th>配置项</th>
            <th>当前值</th>
            <th>将改为</th>
          </tr>
        </thead>
        <tbody>
          {preview.changes.map((change) => (
            <tr key={change.key}>
              <td>{change.key}</td>
              <td className="diff-from">{change.from || '（未设置）'}</td>
              <td className="diff-to">{change.to}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="hint">
        ANTHROPIC_AUTH_TOKEN 写入的不是你的真实 API key，而是本工具生成的一串本地准入凭证
        （每次安装各不相同）。真实 key 仍由本工具保管并按请求注入，因此它不会出现在
        Claude Code 的配置里；本机其它程序就算发现了代理端口，没有这串凭证也用不了。
        {'\n'}模型相关的配置项（ANTHROPIC_MODEL 等）一概不动。
      </p>

      <div className="error-text">{error}</div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={handleConfirm} disabled={writing}>
          确认接管
        </button>
      </div>
    </div>
  );
}
