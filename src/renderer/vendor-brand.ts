// 供应商 logo：从名称与 Base URL 里认品牌，给一个颜色和一个首字母。
//
// 为什么用「色块 + 首字母」而不是官方 SVG：官方标识是各家商标，随包分发有授权问题，
// 而且几十家供应商的图标体量远超这个界面本身。色块能起到同样的作用 ——
// 让用户在一屏卡片里靠颜色一眼认出「哪个是哪家」。
//
// 认不出来的供应商也必须拿到一个稳定的颜色：同一家每次渲染颜色一致，
// 否则用户记住的颜色下次就变了，比没有颜色更糟。

export interface VendorBrand {
  /** 16 进制色值，作为色块底色。 */
  color: string;
  /** 色块上显示的字符，单字符。 */
  initial: string;
}

interface BrandRule {
  /** 匹配供应商名或 Base URL，大小写不敏感。 */
  match: RegExp;
  color: string;
  initial: string;
}

// 顺序有意义：先匹配到的先用。把更具体的词放前面
// （例如 bigmodel 之于智谱 —— 它的 Base URL 里带 bigmodel，名字里却常只写 GLM）。
const RULES: BrandRule[] = [
  { match: /deepseek|深度求索/i, color: '#4d6bfe', initial: 'D' },
  // Kimi 的品牌色是黑，直接用会糊进近黑底，提一档明度保持中性灰
  { match: /moonshot|kimi|月之暗面/i, color: '#3c3d47', initial: 'K' },
  { match: /bigmodel|zhipu|glm|智谱|chatglm/i, color: '#6d4aff', initial: 'G' },
  { match: /dashscope|qwen|通义|千问|aliyun|阿里/i, color: '#615ced', initial: 'Q' },
  { match: /volces|volc|doubao|豆包|火山|方舟/i, color: '#3370ff', initial: 'D' },
  { match: /hunyuan|混元|tencent|腾讯/i, color: '#0052d9', initial: 'H' },
  { match: /ernie|wenxin|文心|baidu|百度/i, color: '#2932e1', initial: 'E' },
  { match: /minimax|海螺/i, color: '#e5484d', initial: 'M' },
  { match: /baichuan|百川/i, color: '#ff6a3d', initial: 'B' },
  { match: /stepfun|阶跃/i, color: '#2ea043', initial: 'S' },
  { match: /sensenova|商汤/i, color: '#00a6a6', initial: 'S' },
  { match: /siliconflow|硅基流动/i, color: '#7c3aed', initial: 'S' },
  { match: /openrouter/i, color: '#6467f2', initial: 'O' },
  { match: /anthropic|claude/i, color: '#d97757', initial: 'C' },
  { match: /openai|chatgpt/i, color: '#10a37f', initial: 'O' },
  { match: /gemini|google|谷歌/i, color: '#4285f4', initial: 'G' },
  { match: /ollama|lmstudio|localhost|127\.0\.0\.1/i, color: '#4b5563', initial: 'L' },
];

// 兜底色板：彼此拉开色相，且在近黑底上都够亮、能压住白色首字母。
// 刻意避开 --accent(#6e7bf2)，否则「认不出的供应商」会撞上界面的强调色。
const FALLBACK_COLORS = [
  '#5b8def',
  '#2f9e6e',
  '#c08a20',
  '#c4553f',
  '#8b5cf6',
  '#0e8a8a',
  '#b45ba8',
  '#6b7280',
];

/** 稳定的字符串散列（djb2 变体）—— 同一个名字永远落到同一个颜色。 */
function hash(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** 取名称的第一个字符；ASCII 字母转大写，中文原样。空白名称兜底为 "?"。 */
function firstGlyph(name: string): string {
  const ch = name.trim().charAt(0);
  if (!ch) return '?';
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}

/**
 * 取供应商 logo 的颜色与首字母。
 *
 * 名称与 Base URL 都会拿去匹配：用户常把卡片命名成「我的中转」这种跟品牌无关的名字，
 * 但地址里往往留着 `api.deepseek.com`，那才是真正的线索。
 */
export function vendorBrand(name: string, baseUrl = ''): VendorBrand {
  const haystack = `${name} ${baseUrl}`;

  for (const rule of RULES) {
    if (rule.match.test(haystack)) {
      return { color: rule.color, initial: rule.initial };
    }
  }

  return {
    color: FALLBACK_COLORS[hash(haystack) % FALLBACK_COLORS.length],
    initial: firstGlyph(name),
  };
}
