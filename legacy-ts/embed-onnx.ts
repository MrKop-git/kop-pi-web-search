/**
 * 本地 ONNX 嵌入（bge-small-zh-v1.5 int8，512 维）。
 * 运行时：onnxruntime-web 的纯 wasm 入口（vendor/ort/），零原生依赖、离线可用。
 * 模型与分词器：vendor/model-bge-small-zh/。
 * 失败（缺文件/加载异常）返回 null，由调用方降级到哈希嵌入。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTokenizer } from "./tokenizer.ts";

export const ONNX_EMBEDDER_ID = "onnx-bge-small-zh-512";
export const ONNX_DIM = 512;

/**
 * 「多源印证」判定阈值（ONNX/bge 语义嵌入的余弦分布与哈希嵌入不同，需单独标定）。
 * 初值 0.60：实测相关中文 0.76 / 相关英文 0.56 / 同域无关 0.45 / 完全无关 0.26。
 */
export const ONNX_SUPPORT_THRESHOLD = 0.6;

export interface Embedder {
	id: string;
	dim: number;
	/** 判定「内容相近」的余弦阈值（各嵌入器按自身分布标定） */
	supportThreshold: number;
	/** kind=query 时按模型约定加检索指令前缀（bge 中文系要求），passage 不加 */
	embed(text: string, kind?: "query" | "passage"): Promise<Float32Array>;
}

/** bge-zh 检索约定：查询侧加指令前缀，文档侧不加。 */
const QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

interface OrtTensor {
	data: Float32Array | BigInt64Array;
	dims: number[];
}

interface OrtSession {
	inputNames: string[];
	outputNames: string[];
	run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}

interface OrtModule {
	env: { wasm: { wasmPaths?: string; numThreads?: number }; logLevel?: string };
	InferenceSession: { create(buf: Uint8Array, opts: Record<string, unknown>): Promise<OrtSession> };
	Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

function l2normalize(v: Float32Array): Float32Array {
	let norm = 0;
	for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
	norm = Math.sqrt(norm);
	if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
	return v;
}

/** 加载本地 ONNX 嵌入器；vendor 目录缺件或加载失败时返回 null。 */
export async function createOnnxEmbedder(vendorDir: string): Promise<Embedder | null> {
	const ortDir = join(vendorDir, "ort");
	const modelDir = join(vendorDir, "model-bge-small-zh");
	const entry = join(ortDir, "ort.wasm.min.mjs");
	const wasm = join(ortDir, "ort-wasm-simd-threaded.wasm");
	const modelPath = join(modelDir, "model_quantized.onnx");
	const tokenizerPath = join(modelDir, "tokenizer.json");
	for (const p of [entry, wasm, modelPath, tokenizerPath]) {
		if (!existsSync(p)) return null;
	}
	try {
		const ort = (await import(pathToFileURL(entry).href)) as unknown as OrtModule;
		ort.env.wasm.wasmPaths = `${ortDir}/`;
		ort.env.wasm.numThreads = 1;
		ort.env.logLevel = "error";
		const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(modelPath)), {
			executionProviders: ["wasm"],
		});
		const tokenizer = loadTokenizer(JSON.parse(readFileSync(tokenizerPath, "utf-8")));
		const hasMask = session.inputNames.includes("attention_mask");
		const hasTypes = session.inputNames.includes("token_type_ids");
		const outName = session.outputNames[0];

		return {
			id: ONNX_EMBEDDER_ID,
			dim: ONNX_DIM,
			supportThreshold: ONNX_SUPPORT_THRESHOLD,
			async embed(text: string, kind: "query" | "passage" = "passage"): Promise<Float32Array> {
				const input = kind === "query" ? QUERY_INSTRUCTION + text : text;
				const ids = tokenizer.encode(input.slice(0, 4000));
				const n = ids.length;
				const inputIds = BigInt64Array.from(ids.map((i) => BigInt(i)));
				const feeds: Record<string, unknown> = {
					input_ids: new ort.Tensor("int64", inputIds, [1, n]),
				};
				if (hasMask) {
					feeds.attention_mask = new ort.Tensor("int64", BigInt64Array.from(new Array(n).fill(1n)), [1, n]);
				}
				if (hasTypes) {
					feeds.token_type_ids = new ort.Tensor("int64", BigInt64Array.from(new Array(n).fill(0n)), [1, n]);
				}
				const out = await session.run(feeds);
				const lhs = out[outName];
				const dim = lhs.dims[2] ?? ONNX_DIM;
				const data = lhs.data as Float32Array;
				// BGE 系用 CLS 池化（不是 mean pooling），实测替换后检索排序明显更准
				const v = new Float32Array(dim);
				for (let d = 0; d < dim; d++) v[d] = data[d];
				return l2normalize(v);
			},
		};
	} catch {
		return null;
	}
}
