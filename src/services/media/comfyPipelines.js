/**
 * 换装/改图流水线辅助函数（从 napcat-plugin-play 抽取并适配）
 *
 * 通过 setComfyConfig() 注入当前 ComfyUI 配置，再调用对应函数构建工作流。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CFG = {}

export function setComfyConfig(cfg = {}) {
    for (const key of Object.keys(CFG)) delete CFG[key]
    Object.assign(CFG, cfg || {})
}

function debugLog(...args) {
    if (globalThis.logger?.debug) globalThis.logger.debug(...args)
}

function readWorkflowByPath(file) {
    const abs = path.isAbsolute(file) ? file : path.join(PLUGIN_ROOT, file)
    if (!fs.existsSync(abs)) throw new Error(`工作流文件不存在：${abs}`)
    return JSON.parse(fs.readFileSync(abs, 'utf8'))
}

export { CFG }

function detectColor(text) {
  const t = String(text || "");
  const changeRe = /(改成|换成|变成|替换成|改为|替换)/g;
  let changeIdx = -1;
  let cm;
  while ((cm = changeRe.exec(t))) changeIdx = cm.index;
  const hits = [];
  for (const color of COLOR_WORDS) {
    const re = new RegExp(color.re.source, "gi");
    let mm;
    let last = -1;
    while ((mm = re.exec(t))) last = mm.index;
    if (last >= 0) hits.push({ idx: last, cn: color.cn });
  }
  if (!hits.length) return "";
  const after = hits.filter((h) => h.idx > changeIdx).sort((a, b) => a.idx - b.idx);
  if (after.length) return after[0].cn;
  return hits.sort((a, b) => b.idx - a.idx)[0].cn;
}

function normalizeLoraText(text) {
  let t = String(text || "").replace(/\r/g, "");
  t = t.replace(/\s*Krea2\//g, "\nKrea2/");
  t = t.replace(/master=on\s*(?=\n)/g, "master=on");
  return t.replace(/^\n+/, "").trim();
}

const EDIT_CHANGE_RE = /(改成|换成|变成|替换成|改为|变成|替换|去除|去掉|删掉|加上|添加|穿上|脱下)/;
const EDIT_CLOTH_RE = /(丝袜|袜|裤|衬衫|上衣|外套|裙子|短裙|裙|衣|鞋|帽|领|发色|头发|眼镜|包)/;
const EDIT_COLOR_RE = /(色|白|黑|红|蓝|绿|粉|紫|黄|灰|棕|金|银|white|black|red|blue|green|pink|purple|yellow|grey|gray|silver|gold)/i;
const COLOR_WORDS = [
  { re: /(米白|米色|beige)/i, cn: "米白色" },
  { re: /(白|white)/i, cn: "白色" },
  { re: /(黑|black)/i, cn: "黑色" },
  { re: /(红|red)/i, cn: "红色" },
  { re: /(蓝|blue)/i, cn: "蓝色" },
  { re: /(绿|green)/i, cn: "绿色" },
  { re: /(粉|pink)/i, cn: "粉色" },
  { re: /(紫|purple|violet)/i, cn: "紫色" },
  { re: /(黄|yellow)/i, cn: "黄色" },
  { re: /(灰|grey|gray)/i, cn: "灰色" },
  { re: /(棕|咖啡|brown)/i, cn: "棕色" },
  { re: /(金|gold)/i, cn: "金色" },
  { re: /(银|silver)/i, cn: "银色" },
  { re: /(橙|orange)/i, cn: "橙色" }
];
const TINT_COLORS = {
  "白色": 0xffffff, "米白色": 0xefe8dc, "黑色": 0x141414, "红色": 0xc62828,
  "蓝色": 0x1e4fd8, "绿色": 0x2e7d32, "粉色": 0xf4a6c0, "紫色": 0x7b3fa0,
  "黄色": 0xf2c200, "灰色": 0x9aa0a6, "棕色": 0x6d4c41, "金色": 0xd4af37,
  "银色": 0xc0c0c0, "橙色": 0xef6c00
};



const DEFAULT_COMFY_EDIT_WORKFLOW = 'data/comfy/krea2_edit.json'
const DEFAULT_COMFY_INPAINT_WORKFLOW = 'data/comfy/krea2_inpaint.json'
let comfyEditCache = { path: '', mtime: 0, data: null }
let comfyInpaintCache = { path: '', mtime: 0, data: null }

function resolveComfyEditWorkflowPath() {
    const custom = String(CFG.comfyEditWorkflow || '').trim()
    return custom
        ? (path.isAbsolute(custom) ? custom : path.join(PLUGIN_ROOT, custom))
        : path.join(PLUGIN_ROOT, DEFAULT_COMFY_EDIT_WORKFLOW)
}

function resolveComfyInpaintWorkflowPath() {
    const custom = String(CFG.comfyInpaintWorkflow || '').trim()
    return custom
        ? (path.isAbsolute(custom) ? custom : path.join(PLUGIN_ROOT, custom))
        : path.join(PLUGIN_ROOT, DEFAULT_COMFY_INPAINT_WORKFLOW)
}

const COMFY_EDIT_REQUIRED_NODES = {
  1: "UNETLoader",
  2: "CLIPLoader",
  3: "VAELoader",
  4: "LoadImage",
  5: "ImageScale",
  6: "VAEEncode",
  7: "CLIPTextEncode",
  8: "ConditioningZeroOut",
  9: "KSampler",
  10: "VAEDecode",
  11: "BSK_SaveImage"
};

const COMFY_INPAINT_REQUIRED_NODES = {
  1: "LoadImage",
  2: "ImageScale",
  3: "ClothesSegment",
  4: "ClothesSegment",
  5: "MaskComposite",
  6: "VAEEncodeForInpaint",
  7: "KSampler",
  8: "VAELoader",
  9: "UNETLoader",
  10: "CLIPTextEncode",
  11: "ConditioningZeroOut",
  12: "CLIPLoader",
  13: "VAEDecode",
  14: "VAEEncode",
  15: "KSampler",
  16: "VAEDecode",
  17: "BSK_SaveImage",
  18: "ClothesSegment",
  19: "ClothesSegment",
  20: "MaskComposite",
  21: "ImageCompositeMasked",
  22: "EmptyImage",
  23: "ImageBlend",
  24: "ImageCompositeMasked"
};

export {
    loadComfyEditWorkflow,
    loadComfyInpaintWorkflow,
    patchComfyEditWorkflow,
    patchComfyInpaintWorkflow,
    readImageSize,
    computeEditSize,
    pickEditDenoise,
    detectGarmentPart,
    buildInpaintPrompt,
    tintColorFor,
    buildEditPrompt,
    pickStyleSuffix,
    normalizeDrawSize,
    buildLoraText,
    isAnimePrompt
}


const GARMENT_PARTS = [
  { label: "连衣裙", re: /(连衣裙|长裙|晚礼服|dress)/i, toggles: ["Dress"],
    desc: (c) => `${c}的连衣裙，布料自然褶皱，光影与画面一致` },
  { label: "丝袜/裤子", re: /(丝袜|连裤袜|打底裤|裤袜|黑丝|白丝|肉丝|薄丝|丝|紧身裤|长裤|短裤|裤子|leggings|tights|stockings|pants)/i, toggles: ["Pants"],
    desc: (c) => `${c}不透明厚丝袜，纯${c}色尼龙，完全不透肉，袜口自然，褶皱与腿型自然，光影与画面一致` },
  { label: "裙子", re: /(裙子|短裙|半身裙|百褶裙|skirt)/i, toggles: ["Skirt"],
    desc: (c) => `${c}色的裙子，布料自然褶皱，光影与画面一致` },
  { label: "上衣", re: /(上衣|衬衫|外套|卫衣|毛衣|t恤|夹克|西服|西装|马甲|shirt|jacket|sweater)/i, toggles: ["Upper-clothes"],
    desc: (c) => `${c}色的上衣，布料质感自然，光影与画面一致` },
  { label: "鞋子", re: /(鞋子|皮鞋|靴子|运动鞋|小皮鞋|鞋|shoes|boots)/i, toggles: ["Left-shoe", "Right-shoe"],
    desc: (c) => `${c}色的鞋子，材质自然，光影与画面一致` },
  { label: "帽子", re: /(帽子|鸭舌帽|贝雷帽|帽|hat|cap)/i, toggles: ["Hat"],
    desc: (c) => `${c}色的帽子，材质自然` },
  { label: "头发", re: /(头发|发色|发型|hair)/i, toggles: ["Hair"],
    desc: (c) => `${c}色的头发，发丝自然` },
  { label: "包包", re: /(背包|挎包|包包|包|bag)/i, toggles: ["Bag"],
    desc: (c) => `${c}色的包，材质自然` }
];

function loadComfyEditWorkflow() {
  const file = resolveComfyEditWorkflowPath();
  if (!fs.existsSync(file)) throw new Error(`改图工作流文件不存在：${file}`);
  const mtime = fs.statSync(file).mtimeMs;
  if (comfyEditCache.path === file && comfyEditCache.mtime === mtime && comfyEditCache.data) {
    return comfyEditCache.data;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  comfyEditCache = { path: file, mtime, data };
  debugLog(`[Comfy] 已加载改图工作流 ${file}`);
  return data;
}

function readImageSize(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0x47 && buf[1] === 0x49) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const fourcc = buf.toString("ascii", 12, 16);
      if (fourcc === "VP8X") {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
      if (fourcc === "VP8 ") {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === "VP8L") {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        return {
          width: 1 + (((b1 & 0x3f) << 8) | b0),
          height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
        };
      }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off += 1; continue; }
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
    }
  } catch {
  }
  return null;
}

function computeEditSize(srcSize, maxSide, minSide) {
  const cap = Math.max(384, parseInt(maxSide, 10) || 1152);
  const floor = Math.max(256, parseInt(minSide, 10) || 0);
  let width = srcSize?.width || 768;
  let height = srcSize?.height || 1152;
  let longest = Math.max(width, height);
  // 源图太小就先放大到目标长边，避免几百像素的图直接出图
  if (floor > longest) {
    const k = floor / longest;
    width = Math.round(width * k);
    height = Math.round(height * k);
    longest = Math.max(width, height);
  }
  if (longest > cap) {
    const k = cap / longest;
    width = Math.round(width * k);
    height = Math.round(height * k);
  }
  const snap = (v) => Math.max(256, Math.round(v / 16) * 16);
  return { width: snap(width), height: snap(height) };
}

function pickEditDenoise(prompt, configured) {
  const base = Math.min(0.98, Math.max(0.3, parseFloat(configured) || 0.85));
  const explicit = /(?:^|\s)-d\s*([0-9]*\.?[0-9]+)/.exec(prompt || "");
  if (explicit) return Math.min(1, Math.max(0.1, parseFloat(explicit[1])));
  const wantChange = EDIT_CHANGE_RE.test(prompt || "");
  const hasColor = EDIT_COLOR_RE.test(prompt || "");
  const hasCloth = EDIT_CLOTH_RE.test(prompt || "");
  if (wantChange && (hasColor || hasCloth)) return Math.max(base, 0.9);
  return base;
}

function detectGarmentPart(text) {
  const t = String(text || "");
  const changeRe = /(改成|换成|变成|替换成|改为|替换|去除|去掉|删掉|加上|添加|穿上|脱下)/;
  if (!changeRe.test(t)) return null;
  let matched = null;
  for (const part of GARMENT_PARTS) {
    if (part.re.test(t)) {
      const hit = t.match(part.re)[0];
      // 取最长匹配的关键词所在部位，避免「连衣裙」被「裙子」抢先
      if (!matched || hit.length > matched.hit.length) {
        matched = { part, hit };
      }
    }
  }
  if (!matched) return null;
  return { part: matched.part, color: detectColor(t) };
}

function buildInpaintPrompt(userText, match) {
  const desc = match.color ? match.part.desc(match.color) : `${match.part.label}，颜色与材质自然，光影与画面协调`;
  return `${desc}。${match.color ? "" : String(userText || "") + "。"}只重绘该区域，画面其余部分保持原样。`;
}

function tintColorFor(colorName) {
  return TINT_COLORS[colorName] || 0xffffff;
}

function loadComfyInpaintWorkflow() {
  const file = resolveComfyInpaintWorkflowPath();
  if (!fs.existsSync(file)) throw new Error(`分割重绘工作流文件不存在：${file}`);
  const mtime = fs.statSync(file).mtimeMs;
  if (comfyInpaintCache.path === file && comfyInpaintCache.mtime === mtime && comfyInpaintCache.data) {
    return comfyInpaintCache.data;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  comfyInpaintCache = { path: file, mtime, data };
  debugLog(`[Comfy] 已加载分割重绘工作流 ${file}`);
  return data;
}

function patchComfyInpaintWorkflow(base, opts) {
  const wf = JSON.parse(JSON.stringify(base));
  for (const [id, classType] of Object.entries(COMFY_INPAINT_REQUIRED_NODES)) {
    if (!wf[id]) throw new Error(`分割重绘工作流缺少节点 ${id}（${classType}）`);
  }
  wf["1"].inputs.image = opts.image;
  wf["2"].inputs.width = opts.width;
  wf["2"].inputs.height = opts.height;
  // 节点 3：目标服装掩码（外扩，盖住轮廓暗边）
  for (const toggle of opts.toggles) wf["3"].inputs[toggle] = true;
  wf["3"].inputs.process_res = opts.processRes;
  wf["3"].inputs.mask_blur = opts.maskBlur;
  wf["3"].inputs.mask_offset = opts.maskOffset;
  // 节点 4：背景掩码（收缩，少减一点，避免把腿轮廓切掉）
  wf["4"].inputs.process_res = opts.processRes;
  wf["4"].inputs.mask_blur = opts.maskBlur;
  wf["4"].inputs.mask_offset = opts.bgOffset;
  // 节点 18/19：覆盖蒙版，范围与重绘一致（外扩同宽）+ 更大羽化，避免贴回未重绘的黑色边缘
  for (const toggle of opts.toggles) wf["18"].inputs[toggle] = true;
  wf["18"].inputs.process_res = opts.processRes;
  wf["18"].inputs.mask_blur = opts.coverBlur;
  wf["18"].inputs.mask_offset = opts.coverOffset;
  wf["19"].inputs.process_res = opts.processRes;
  wf["19"].inputs.mask_blur = opts.coverBlur;
  wf["19"].inputs.mask_offset = opts.bgOffset;
  wf["6"].inputs.grow_mask_by = opts.growMask;
  wf["7"].inputs.seed = Number(opts.seed) || 0;
  wf["7"].inputs.steps = opts.steps;
  wf["7"].inputs.denoise = opts.denoise;
  wf["10"].inputs.text = opts.prompt;
  // 节点 15：全图统一 pass（可选；<=0 时直接从合成结果出图，避免把白色又抹回原色）
  const unify = Number(opts.unify) || 0;
  if (unify > 0.01) {
    wf["15"].inputs.seed = (Number(opts.seed) || 0) + 7;
    wf["15"].inputs.steps = opts.steps;
    wf["15"].inputs.denoise = unify;
    wf["17"].inputs.images = ["16", 0];
  } else {
    wf["17"].inputs.images = ["21", 0];
  }
  // 节点 22/23/24：按比例把目标颜色混进掩码区域（消除 AI 生成偏灰/不一致）
  const tint = Number(opts.tint) || 0;
  wf["22"].inputs.width = opts.width;
  wf["22"].inputs.height = opts.height;
  wf["22"].inputs.color = opts.targetColor;
  wf["23"].inputs.blend_factor = tint;
  wf["17"].inputs.images = tint > 0.01 ? ["24", 0] : ["21", 0];
  if (opts.prefix) wf["17"].inputs.filename_prefix = opts.prefix;
  return wf;
}

function patchComfyEditWorkflow(base, opts) {
  const wf = JSON.parse(JSON.stringify(base));
  for (const [id, classType] of Object.entries(COMFY_EDIT_REQUIRED_NODES)) {
    if (!wf[id]) throw new Error(`改图工作流缺少节点 ${id}（${classType}）`);
  }
  wf["4"].inputs.image = opts.image;
  wf["5"].inputs.width = opts.width;
  wf["5"].inputs.height = opts.height;
  wf["7"].inputs.text = opts.prompt;
  const negText = String(opts.negative || "").trim();
  if (negText) {
    wf["12"] = { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negText } };
    wf["9"].inputs.negative = ["12", 0];
    wf["9"].inputs.cfg = Number(opts.negCfg) || 1.4;
  } else {
    wf["9"].inputs.cfg = 1.0;
  }
  wf["9"].inputs.seed = Number(opts.seed) || 0;
  wf["9"].inputs.steps = opts.steps;
  wf["9"].inputs.denoise = opts.denoise;
  if (opts.prefix) wf["11"].inputs.filename_prefix = opts.prefix;
  return wf;
}

function buildEditPrompt(prompt) {
  const cleaned = String(prompt || "").replace(/(?:^|\s)-d\s*[0-9]*\.?[0-9]+/g, " ").trim();
  if (!cleaned) return "";
  return `${cleaned}。保持原有构图、人物姿势、背景、光线、镜头角度以及其他衣物细节不变。`;
}

function pickStyleSuffix(prompt) {
  const manual = String(CFG.comfyStyleHint || "").trim();
  if (manual) return manual.startsWith(",") ? manual : `, ${manual}`;
  if (CFG.comfyStyleAuto === false) return "";
  const t = String(prompt || "");
  const anime = /(二次元|动漫|动画|番剧|插画|漫画|anime|2d|manga|illustration|cel.?shad)/i.test(t);
  const photo = /(真人|写实|照片|摄影|实拍|真实|高清摄影|photoreal|photo|realistic|real person|35mm|dslr)/i.test(t);
  if (anime && !photo) return ", anime style, cel shading, clean lineart";
  if (photo && !anime) return ", photorealistic, real photograph, natural skin texture, soft studio light, sharp focus";
  return "";
}

function normalizeDrawSize(width, height) {
  if (!width || !height) return null;
  const cap = Math.max(256, parseInt(CFG.comfyMaxSide, 10) || 1536);
  const snap = (v) => Math.max(256, Math.round(v / 16) * 16);
  let w = snap(width);
  let h = snap(height);
  const longSide = Math.max(w, h);
  if (longSide > cap) {
    const k = cap / longSide;
    w = snap(w * k);
    h = snap(h * k);
  }
  return { width: w, height: h };
}

function buildLoraText(prompt) {
  const base = normalizeLoraText(CFG.comfyLoraText !== void 0 ? CFG.comfyLoraText : "master=on");
  const animeExtra = normalizeLoraText(CFG.comfyAnimeLoraText || "");
  const useAnime = CFG.comfyAnimeAuto !== false && animeExtra && isAnimePrompt(prompt);
  return useAnime ? `${base}\n${animeExtra}` : base;
}

function isAnimePrompt(prompt) {
  const t = String(prompt || "");
  const anime = /(二次元|动漫|动画|番剧|插画|漫画|anime|2d|manga|illustration|cel.?shad)/i.test(t);
  const photo = /(真人|写实|照片|摄影|实拍|真实|photoreal|photo|realistic|real person|35mm|dslr)/i.test(t);
  return anime && !photo;
}

function randomComfySeed() {
  return String(Math.floor(Math.random() * 1e15));
}
