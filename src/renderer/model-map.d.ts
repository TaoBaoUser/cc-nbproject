// 为 CommonJS 的 model-map.js 提供类型（实现见同名 .js 文件，双端加载、测试用 require）。
export declare function parseModelMap(text: string): Record<string, string>;
export declare function findModelMapProblems(map: Record<string, string>): string[];
export declare function suggestModelMapping(sourceName: string, modelIds: string[]): string | null;
