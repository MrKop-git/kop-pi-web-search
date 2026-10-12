/**
 * 极简 BERT/WordPiece 分词器（零依赖，纯函数）。
 * 支持 HF `tokenizer.json`（BertTokenizer + WordPiece + TemplateProcessing），
 * 供本地 ONNX 嵌入模型（bge-small-zh 等）使用。
 */

interface TokenizerJson {
	model?: {
		vocab?: Record<string, number>;
		unk_token?: string;
		continuing_subword_prefix?: string;
	};
	normalizer?: { lowercase?: boolean; strip_accents?: boolean | null; handle_chinese_chars?: boolean } | null;
	post_processor?: unknown;
}

export interface Tokenizer {
	/** 编码为模型输入 id 序列（含 [CLS]/[SEP]）。 */
	encode(text: string, maxLen?: number): number[];
	/** id → token（调试/测试用）。 */
	decode(ids: number[]): string[];
	specials: { cls: number; sep: number; unk: number; pad: number };
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;

function isPunctuation(ch: string): boolean {
	// BERT 的 _is_punctuation：ASCII 标点 + 常见 Unicode 标点块
	const code = ch.codePointAt(0) ?? 0;
	if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) {
		return true;
	}
	return /[ -⁯⸀-⹿　-〿＀-￯]/.test(ch);
}

/** 中文/空白/标点切分（BERT BasicTokenizer 的 pre-tokenize 行为）。 */
export function basicTokenize(text: string): string[] {
	// clean_text：控制字符去掉、空白统一为空格
	let s = "";
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		if (c === 0 || c === 0xfffd) continue;
		if (/\s/.test(ch)) {
			s += " ";
			continue;
		}
		s += ch;
	}
	// 中文（及日韩）字符两侧补空格
	let spaced = "";
	for (const ch of s) {
		if (CJK_RE.test(ch)) spaced += ` ${ch} `;
		else spaced += ch;
	}
	const out: string[] = [];
	for (const token of spaced.split(/\s+/).filter(Boolean)) {
		// 标点单独成 token
		let buf = "";
		for (const ch of token) {
			if (isPunctuation(ch)) {
				if (buf) {
					out.push(buf);
					buf = "";
				}
				out.push(ch);
			} else {
				buf += ch;
			}
		}
		if (buf) out.push(buf);
	}
	return out;
}

/** WordPiece：贪婪最长匹配，续片加 "##" 前缀，失败回退 [UNK]。 */
export function wordpieceTokenize(token: string, vocab: Map<string, number>, continuingPrefix = "##"): string[] {
	if (token.length > 100) return []; // BERT 的 max_input_chars_per_word
	const pieces: string[] = [];
	let start = 0;
	while (start < token.length) {
		let end = token.length;
		let cur = "";
		while (start < end) {
			let sub = token.slice(start, end);
			if (start > 0) sub = continuingPrefix + sub;
			if (vocab.has(sub)) {
				cur = sub;
				break;
			}
			end--;
		}
		if (!cur) return []; // 整词丢弃 → 上层用 [UNK]
		pieces.push(cur);
		start = end;
	}
	return pieces;
}

export function loadTokenizer(json: unknown): Tokenizer {
	const data = (json ?? {}) as TokenizerJson;
	const vocabObj = data.model?.vocab;
	if (!vocabObj || typeof vocabObj !== "object") {
		throw new Error("tokenizer.json 缺少 model.vocab（需 HF fast tokenizer 格式）");
	}
	const vocab = new Map<string, number>(Object.entries(vocabObj));
	const unkToken = data.model?.unk_token ?? "[UNK]";
	const prefix = data.model?.continuing_subword_prefix ?? "##";
	const lowercase = data.normalizer?.lowercase === true;
	const stripAccents = data.normalizer?.strip_accents === true;
	const cls = vocab.get("[CLS]");
	const sep = vocab.get("[SEP]");
	const unk = vocab.get(unkToken);
	const pad = vocab.get("[PAD]") ?? 0;
	if (cls === undefined || sep === undefined || unk === undefined) {
		throw new Error("tokenizer.json 缺少 [CLS]/[SEP]/[UNK] 词表项");
	}

	const normalize = (text: string): string => {
		let s = text.normalize("NFD");
		if (stripAccents) s = s.replace(/[̀-ͯ]/g, "");
		s = s.normalize("NFC");
		if (lowercase) s = s.toLowerCase();
		return s;
	};

	return {
		specials: { cls, sep, unk, pad },
		decode(ids: number[]): string[] {
			const inv = new Map<number, string>();
			for (const [tok, id] of vocab) inv.set(id, tok);
			return ids.map((i) => inv.get(i) ?? unkToken);
		},
		encode(text: string, maxLen = 512): number[] {
			const words = basicTokenize(normalize(text));
			const ids: number[] = [cls];
			for (const w of words) {
				const pieces = wordpieceTokenize(w, vocab, prefix);
				if (pieces.length === 0) ids.push(unk);
				else for (const p of pieces) ids.push(vocab.get(p) ?? unk);
				if (ids.length >= maxLen - 1) break;
			}
			ids.length = Math.min(ids.length, maxLen - 1);
			ids.push(sep);
			return ids;
		},
	};
}
