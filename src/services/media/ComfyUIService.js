/**
 * ComfyUI 绘图服务
 *
 * 移植自 napcat-plugin-play 的 Krea2 工作流实现：
 * - 文生图 / 图生图（参考图上传后走 BSK_LoadImage）
 * - LoRA 行、二次元自动追加、负向提示词、步数/尺寸/放大/二采
 *
 * 工作流依赖 ComfyUI 服务端安装的自定义节点（bsk_* / ComfySwitchNode / RandomSeedNode），
 * 与 napcat-plugin-play 使用同一份 krea2_workflow.json。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../../../config/config.js'
import {
    setComfyConfig,
    detectGarmentPart,
    buildInpaintPrompt,
    tintColorFor,
    loadComfyInpaintWorkflow,
    patchComfyInpaintWorkflow,
    loadComfyEditWorkflow,
    patchComfyEditWorkflow,
    computeEditSize,
    readImageSize,
    pickEditDenoise,
    buildEditPrompt,
    pickStyleSuffix
} from './comfyPipelines.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const POLL_MS = 1500

const REQUIRED_NODES = {
    34: 'bsk_UNETLoader',
    35: 'bsk_CLIPLoader',
    36: 'bsk_VAELoader',
    37: 'bsk_MultiLoraLoaderWithPath',
    22: 'BSK_LoadImage',
    21: 'BSK_ParamSet',
    31: 'RandomSeedNode',
    29: 'MultiLineStringEditor',
    26: 'MultiLineStringEditor',
    18: 'KSamplerAdvanced',
    19: 'KSamplerAdvanced',
    28: 'BSK_SaveImage'
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...args) => (globalThis.logger?.mark || globalThis.logger?.info || console.log)?.(...args)

function normalizeBase(raw) {
    const value = String(raw || '').trim()
    if (!value) return ''
    return (/^https?:\/\//i.test(value) ? value : `http://${value}`).replace(/\/+$/, '')
}

/** 把配置里可能被压成一行的 LoRA 文本还原成多行 */
export function normalizeLoraText(text) {
    let t = String(text || '').replace(/\r/g, '')
    t = t.replace(/\s*Krea2\//g, '\nKrea2/')
    t = t.replace(/master=on\s*(?=\n)/g, 'master=on')
    return t.replace(/^\n+/, '').trim()
}

export function isAnimePrompt(prompt) {
    const t = String(prompt || '')
    const anime = /(二次元|动漫|动画|番剧|插画|漫画|anime|2d|manga|illustration|cel.?shad)/i.test(t)
    const photo = /(真人|写实|照片|摄影|实拍|真实|photoreal|photo|realistic|real person|35mm|dslr)/i.test(t)
    return anime && !photo
}

function parseSize(size, maxSide = 2460) {
    const [w, h] = String(size || '768x1152')
        .toLowerCase()
        .split(/[x×*,]/)
    const clamp = n => Math.max(64, Math.min(Number(maxSide) || 2460, Math.round(n / 8) * 8))
    return { width: clamp(parseInt(w, 10) || 768), height: clamp(parseInt(h, 10) || 1152) }
}

function formatComfyError(data) {
    if (!data) return ''
    const parts = []
    if (data.error) parts.push(typeof data.error === 'string' ? data.error : JSON.stringify(data.error))
    for (const [id, err] of Object.entries(data.node_errors || {})) {
        const first = err?.errors?.[0]
        const msg = first?.message || first?.details || ''
        if (msg) parts.push(`节点${id}：${msg}`)
    }
    if (!parts.length && data.node_errors) parts.push('工作流参数校验失败')
    return parts.join('；')
}


/** 把模型的描述压成绘图提示词（纯代码，不依赖额外 LLM） */
export function narrativeToTags(narrative) {
    let t = String(narrative || '')
    t = t.replace(/```[a-zA-Z]*\s*/g, ' ').replace(/```/g, ' ')
    t = t.replace(/[*_`>#]+/g, '')
    t = t.replace(/(^|[\s,])[-•·]\s+/g, ', ')
    t = t.replace(
        /^(the (image|picture|photo|screenshot|frame|scene)\s+(is|shows|depicts|captures|features)|this (is|image|picture|photo|screenshot)|it (is|shows|depicts)|an? (image|photo|picture|screenshot) of|we see|here (is|we see))\s*/i,
        ''
    )
    t = t.replace(/\bwith the following (features|details)\b\s*[:：]?/gi, ' ')
    t = t.replace(/\bthe following (features|details)\b\s*[:：]?/gi, ' ')
    t = t.replace(/\bfeatures\s*[:：]/gi, ' ')
    t = t.replace(
        /\b(appearance|attire|clothing|clothes|outfit|dress|top|bottom|legwear|footwear|shoes?|socks?|stockings?|tights?|skirt|pants|blazer|shirt|jacket|ears?\s*(&\s*|\/\s*)?\s*tail|ears?|tail|eyes?|hair|face|expression|pose|posture|background|scene|setting|lighting|camera|angle|style|colors?|accessories|details|features)\s*[:：]/gi,
        ', '
    )
    t = t.replace(/\r?\n+/g, ', ').replace(/\s*;\s*/g, ', ').replace(/\s+and\s+/gi, ', ')
    t = t.replace(/[.。!！?？]+/g, ', ').replace(/\s*,\s*/g, ', ')
    t = t.replace(/\s+/g, ' ').replace(/^,\s*/, '').trim()
    const bad =
        /^(is|are|was|were|has|have|shows|showing|depicts|depicting|appears?|seems?|looks?|with|in|on|at|she|he|it|they|her|his|their|its|there|this|that)$/i
    const tags = []
    const seen = new Set()
    for (const raw of t.split(',')) {
        const tag = raw
            .trim()
            .replace(
                /^(?:she|he|it|they|her|his|their|its)\s+(?:\w+\s+)?(?:has|have|is|are|was|were|wears|wearing|appears?|looks?|stands?|sits?|poses?|posing|holds?|holding)\s+/i,
                ''
            )
            .replace(/^(?:a|an|the)\s+/i, '')
            .replace(/[.。!！?？:：]+$/, '')
            .trim()
        if (!tag || tag.length < 2 || bad.test(tag)) continue
        if (/(elements?|details?|features?|following)$/i.test(tag)) continue
        if (/(here.?s what|here what|here is what|what.?s visible|the image|this image|in the image|as follows)/i.test(tag)) continue
        const key = tag.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        tags.push(tag)
        if (tags.length >= 34) break
    }
    let joined = tags.join(', ')
    if (joined.length < 30) return t
    if (joined.length > 480) {
        const cut = joined.slice(0, 480)
        const lastComma = cut.lastIndexOf(', ')
        joined = lastComma > 120 ? cut.slice(0, lastComma) : cut
    }
    return joined
}

class ComfyUIService {
    constructor() {
        this._workflowCache = null
        this._workflowMtime = 0
    }

    get cfg() {
        return config.get('features.comfyDraw') || {}
    }

    get enabled() {
        return this.cfg.enabled !== false
    }

    normalizeBase() {
        return normalizeBase(this.cfg.baseUrl)
    }

    workflowPath() {
        const rel = this.cfg.workflow || 'data/comfy/krea2_workflow.json'
        return path.isAbsolute(rel) ? rel : path.join(PLUGIN_ROOT, rel)
    }

    loadWorkflow() {
        const file = this.workflowPath()
        const stat = fs.statSync(file)
        if (this._workflowCache && stat.mtimeMs === this._workflowMtime) return this._workflowCache
        const wf = JSON.parse(fs.readFileSync(file, 'utf8'))
        for (const [id, classType] of Object.entries(REQUIRED_NODES)) {
            if (!wf[id]) throw new Error(`工作流缺少节点 ${id}（${classType}）`)
        }
        this._workflowCache = wf
        this._workflowMtime = stat.mtimeMs
        return wf
    }

    buildLoraText(prompt) {
        const cfg = this.cfg
        const base = normalizeLoraText(cfg.loraText !== undefined ? cfg.loraText : 'master=on')
        const animeExtra = normalizeLoraText(cfg.animeLoraText || '')
        const useAnime = cfg.animeAuto !== false && !!animeExtra && isAnimePrompt(prompt)
        return useAnime ? `${base}\n${animeExtra}` : base
    }

    patchWorkflow(base, opts) {
        const wf = JSON.parse(JSON.stringify(base))
        const { width, height } = parseSize(opts.size || this.cfg.size, this.cfg.maxSide)
        const isI2i = opts.mode === 'i2i' && opts.image

        wf['37'].inputs.lora_text = normalizeLoraText(opts.loraText !== undefined ? opts.loraText : this.buildLoraText(opts.prompt))
        wf['22'].inputs.image = opts.image || wf['22'].inputs.image || 'example.png'
        wf['22'].inputs.output_empty_latent = !isI2i
        wf['22'].inputs.crop_params = `0,0,0,0,0,${width},${height}`

        wf['21'].inputs.value1 = String(opts.steps)
        wf['21'].inputs.value3 = String(opts.steps)
        wf['21'].inputs.value4 = String(opts.scale)
        wf['21'].inputs.value5 = opts.twoPass ? 'true' : 'false'
        wf['21'].inputs.value7 = isI2i ? 'false' : 'true'
        wf['21'].inputs.value8 = String(opts.denoise)

        wf['31'].inputs.seed_str = String(opts.seed || Math.floor(Math.random() * 1e15))
        wf['29'].inputs.text = String(opts.prompt || '')
        if (opts.negative !== undefined) wf['26'].inputs.text = String(opts.negative || '')
        const negText = String(opts.negative || '').trim()
        if (negText) {
            const cfg = Number(opts.negCfg) || 1.4
            if (wf['18']) wf['18'].inputs.cfg = cfg
            if (wf['19']) wf['19'].inputs.cfg = cfg
        }
        if (opts.prefix) wf['28'].inputs.filename_prefix = opts.prefix
        return wf
    }

    async getJson(base, pathname, timeoutMs = 15000) {
        const res = await fetch(base + pathname, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) return null
        return await res.json().catch(() => null)
    }

    async uploadImage(buffer, filename = `chaite_${Date.now()}.png`) {
        const base = this.normalizeBase()
        const form = new FormData()
        form.append('image', new Blob([buffer]), filename)
        form.append('overwrite', 'true')
        const res = await fetch(`${base}/upload/image`, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(60000)
        })
        if (!res.ok) throw new Error(`上传参考图失败 HTTP ${res.status}`)
        const info = await res.json().catch(() => null)
        if (!info?.name) throw new Error('上传参考图无返回文件名')
        return info.subfolder ? `${info.subfolder}/${info.name}` : info.name
    }

    async runWorkflow(base, wf, timeoutMs) {
        const res = await fetch(`${base}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: wf, client_id: `chaite-${Date.now()}` }),
            signal: AbortSignal.timeout(30000)
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data?.prompt_id) {
            throw new Error(formatComfyError(data) || `提交工作流失败 HTTP ${res.status}`)
        }
        const promptId = data.prompt_id
        const startAt = Date.now()
        while (Date.now() - startAt < timeoutMs) {
            await sleep(POLL_MS)
            const hist = await this.getJson(base, `/history/${promptId}`)
            const entry = hist?.[promptId]
            if (!entry) continue
            const status = entry.status || {}
            if (status.status_str === 'error') {
                const msgs = (status.messages || []).map(m => m?.[1]?.exception_message).filter(Boolean)
                throw new Error(`执行出错：${msgs[0] || '未知错误'}`)
            }
            const files = []
            for (const out of Object.values(entry.outputs || {})) {
                for (const img of out?.images || []) files.push(img)
            }
            if (status.completed) {
                if (!files.length) throw new Error('工作流执行完成但没有输出图片')
                return { promptId, files }
            }
        }
        throw new Error(`等待出图超时（${Math.round(timeoutMs / 1000)} 秒）`)
    }

    async fetchImage(base, file) {
        const query = new URLSearchParams({
            filename: file.filename,
            subfolder: file.subfolder || '',
            type: file.type || 'output'
        })
        const res = await fetch(`${base}/view?${query.toString()}`, { signal: AbortSignal.timeout(120000) })
        if (!res.ok) throw new Error(`取回图片失败 HTTP ${res.status}`)
        return Buffer.from(await res.arrayBuffer())
    }

    captionWorkflowPath() {
        const rel = this.cfg.captionWorkflow || 'data/comfy/krea2_caption.json'
        return path.isAbsolute(rel) ? rel : path.join(PLUGIN_ROOT, rel)
    }

    loadCaptionWorkflow() {
        const file = this.captionWorkflowPath()
        if (!fs.existsSync(file)) throw new Error(`识图工作流不存在：${file}`)
        const wf = JSON.parse(fs.readFileSync(file, 'utf8'))
        for (const id of ['1', '3']) {
            if (!wf[id]) throw new Error(`识图工作流缺少节点 ${id}`)
        }
        return wf
    }

    async runCaptionWorkflow(base, wf, timeoutMs) {
        const res = await fetch(`${base}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: wf, client_id: `chaite-cap-${Date.now()}` }),
            signal: AbortSignal.timeout(30000)
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data?.prompt_id) {
            throw new Error(formatComfyError(data) || `提交识图失败 HTTP ${res.status}`)
        }
        const promptId = data.prompt_id
        const startAt = Date.now()
        while (Date.now() - startAt < timeoutMs) {
            await sleep(POLL_MS)
            const hist = await this.getJson(base, `/history/${promptId}`)
            const entry = hist?.[promptId]
            if (!entry) continue
            const status = entry.status || {}
            if (status.status_str === 'error') {
                const msgs = (status.messages || []).map(m => m?.[1]?.exception_message).filter(Boolean)
                throw new Error(`识图出错：${msgs[0] || '未知错误'}`)
            }
            if (status.completed) {
                const texts = []
                for (const out of Object.values(entry.outputs || {})) {
                    for (const t of out?.text || []) if (typeof t === 'string' && t.trim()) texts.push(t.trim())
                }
                if (!texts.length) throw new Error('识图完成但没有返回文本')
                let out = texts.join('\n').trim()
                out = out.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '')
                out = out.replace(/^(prompt|Prompt|PROMPT|提示词|英文提示词|Tags?)\s*[:：]\s*/, '')
                return out.replace(/\n{2,}/g, '\n').trim()
            }
        }
        throw new Error(`识图超时（${Math.round(timeoutMs / 1000)} 秒）`)
    }

    /** 直接把图片交给 DeepSeek 视觉模型，产出绘图提示词 */
    async captionWithDeepSeek(imageBuffer) {
        const cfg = this.cfg
        if (!imageBuffer || imageBuffer.length < 512) throw new Error('缺少可用的图片')
        const instruction =
            String(cfg.captionTagsPrompt || '').trim() ||
            'Convert the image into ONE English text-to-image prompt as comma-separated tags. Output only the tags.'
        const model = String(cfg.captionModel || '').trim() || undefined
        const mime = imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 ? 'image/png' : 'image/jpeg'
        const dataUrl = `data:${mime};base64,${imageBuffer.toString('base64')}`

        const { LlmService } = await import('../llm/LlmService.js')
        const { delegateRequest } = await import('../llm/LlmDelegator.js')
        const client = await LlmService.getChatClient({ model })
        const result = await delegateRequest({
            userMessage: {
                role: 'user',
                content: [
                    { type: 'text', text: '请描述这张图，并按系统要求输出绘图提示词。' },
                    { type: 'image_url', image_url: { url: dataUrl } }
                ]
            },
            initialModel: model || client._channelInfo?.model,
            initialChannel: client._channelInfo?.channel || null,
            initialClient: client,
            clientBaseOptions: {},
            requestOptions: {
                model,
                maxToken: 300,
                disableHistorySave: true,
                systemOverride: instruction,
                temperature: 0.3
            },
            event: null,
            source: '识图反推'
        })
        const text =
            result.response?.contents?.find?.(c => c.type === 'text')?.text ||
            result.response?.content?.find?.(c => c.type === 'text')?.text ||
            ''
        return String(text)
            .replace(/```[a-zA-Z]*\s*/g, '')
            .replace(/```/g, '')
            .replace(/^(prompt|提示词|英文提示词|tags?)\s*[:：]\s*/i, '')
            .trim()
    }

    /** 用 DeepSeek 把图片描述压成绘图提示词 */
    async refinePromptWithDeepSeek(narrative) {
        const cfg = this.cfg
        const instruction =
            String(cfg.captionTagsPrompt || '').trim() ||
            'Convert the image description into ONE English text-to-image prompt as comma-separated tags. Output only the tags.'
        const model = String(cfg.captionModel || '').trim() || undefined
        const { LlmService } = await import('../llm/LlmService.js')
        const { delegateRequest } = await import('../llm/LlmDelegator.js')
        const client = await LlmService.getChatClient({ model })
        const result = await delegateRequest({
            userMessage: { role: 'user', content: [{ type: 'text', text: String(narrative || '') }] },
            initialModel: model || client._channelInfo?.model,
            initialChannel: client._channelInfo?.channel || null,
            initialClient: client,
            clientBaseOptions: {},
            requestOptions: {
                model,
                maxToken: 300,
                disableHistorySave: true,
                systemOverride: instruction,
                temperature: 0.3
            },
            event: null,
            source: '识图反推'
        })
        const text =
            result.response?.contents?.find?.(c => c.type === 'text')?.text ||
            result.response?.content?.find?.(c => c.type === 'text')?.text ||
            ''
        return String(text).trim()
    }

    /**
     * 识图反推：图片 → 描述 → 绘图提示词
     * @param {Object} options
     * @param {Buffer} options.imageBuffer
     * @returns {Promise<{narrative: string, prompt: string}>}
     */
    async caption({ imageBuffer }) {
        const cfg = this.cfg
        if (cfg.captionEnabled === false) throw new Error('识图反推未启用')
        if (!imageBuffer || imageBuffer.length < 512) throw new Error('缺少可用的图片')

        // 优先：DeepSeek 视觉直接看图片出提示词
        if (cfg.captionUseDeepSeek !== false) {
            try {
                const prompt = await this.captionWithDeepSeek(imageBuffer)
                if (prompt) {
                    log(`[ComfyDraw] DeepSeek 视觉反推成功：${prompt.slice(0, 60)}`)
                    return { narrative: '', prompt }
                }
            } catch (err) {
                log(`[ComfyDraw] DeepSeek 视觉反推失败，回退本地：${err.message}`)
            }
        }

        const base = this.normalizeBase()
        if (!base) throw new Error('未配置 ComfyUI 地址（features.comfyDraw.baseUrl）')

        const ext = imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 ? '.png' : '.jpg'
        const imageName = await this.uploadImage(imageBuffer, `chaite_cap_${Date.now()}${ext}`)
        const wf = this.loadCaptionWorkflow()
        wf['1'].inputs.image = imageName
        wf['3'].inputs.prompt = cfg.captionPrompt || "what's in the images"
        wf['3'].inputs.max_length = Number(cfg.captionMaxLen) || 320

        const timeoutMs = (Number(cfg.timeoutSeconds) || 600) * 1000
        const narrative = (await this.runCaptionWorkflow(base, wf, timeoutMs)).trim()
        if (!narrative) throw new Error('识图没有返回内容')
        let prompt
        if (cfg.captionStage2 === false) {
            prompt = narrative
        } else if (cfg.captionUseDeepSeek !== false) {
            // 优先让 DeepSeek 按 captionTagsPrompt 生成绘图提示词，失败再退回本地压缩
            try {
                prompt = (await this.refinePromptWithDeepSeek(narrative)) || narrativeToTags(narrative)
            } catch (err) {
                log(`[ComfyDraw] DeepSeek 反推失败，回退本地压缩：${err.message}`)
                prompt = narrativeToTags(narrative)
            }
        } else {
            prompt = narrativeToTags(narrative)
        }
        log(`[ComfyDraw] 识图完成：描述 ${narrative.length} 字 → 提示词 ${prompt.length} 字`)
        return { narrative, prompt }
    }

    /**
     * 生成图片
     * @param {Object} options
     * @param {string} options.prompt
     * @param {string} [options.negative]
     * @param {Buffer|null} [options.imageBuffer] 参考图（图生图）
     * @param {string} [options.size] 形如 768x1152
     * @param {number} [options.count]
     * @returns {Promise<Buffer[]>}
     */
    async generate(options = {}) {
        const cfg = this.cfg
        const base = this.normalizeBase()
        if (!base) throw new Error('未配置 ComfyUI 地址（features.comfyDraw.baseUrl）')

        const maxBatch = Math.max(1, Math.min(9, Number(cfg.maxBatch) || 9))
        const count = Math.max(1, Math.min(maxBatch, Number(options.count) || 1))
        const timeoutMs = (Number(cfg.timeoutSeconds) || 300) * 1000
        const prompt = String(options.prompt || '').trim()
        if (!prompt) throw new Error('提示词为空')

        const styleHint = String(cfg.styleHint || '').trim()
        const finalPrompt = styleHint ? `${prompt}, ${styleHint}` : prompt
        const negative = options.negative !== undefined ? options.negative : cfg.negative || ''
        const steps = Math.max(1, Math.min(60, Number(options.steps) || Number(cfg.steps) || 8))
        const scale = Number(options.scale) || Number(cfg.scale) || 1.5
        const denoise = Number(options.denoise) || Number(cfg.denoise) || 0.85
        const size = options.size || cfg.size || '768x1152'

        setComfyConfig({
            ...cfg,
            comfyStyleHint: cfg.styleHint,
            comfyStyleAuto: cfg.styleAuto !== false,
            comfyLoraText: cfg.loraText,
            comfyAnimeLoraText: cfg.animeLoraText,
            comfyAnimeAuto: cfg.animeAuto,
            comfyI2iDenoise: cfg.denoise,
            comfyMaxSide: cfg.maxSide
        })

        let imageName = ''
        let srcSize = null
        if (options.imageBuffer && options.imageBuffer.length > 512) {
            const ext = options.imageBuffer[0] === 0x89 && options.imageBuffer[1] === 0x50 ? '.png' : '.jpg'
            imageName = await this.uploadImage(options.imageBuffer, `chaite_${Date.now()}${ext}`)
            srcSize = readImageSize(options.imageBuffer)
        }

        const workflow = this.loadWorkflow()
        const buffers = []
        for (let i = 0; i < count; i++) {
            let wf
            if (imageName) {
                const garment = cfg.inpaintEnabled === false ? null : detectGarmentPart(finalPrompt)
                // 显式指定尺寸就按指定值；否则保持源图比例，长边至少放大到默认尺寸的长边
                const baseSize = parseSize(size, cfg.maxSide)
                const minLongSide = Math.max(baseSize.width, baseSize.height)
                const sizeObj = options.size
                    ? parseSize(options.size, Number(cfg.i2iMaxSide) || 2460)
                    : computeEditSize(srcSize, Number(cfg.i2iMaxSide) || 2460, minLongSide)
                if (garment) {
                    // 分割重绘：只改指定部位（换装/换色最准）
                    wf = patchComfyInpaintWorkflow(loadComfyInpaintWorkflow(), {
                        image: imageName,
                        width: sizeObj.width,
                        height: sizeObj.height,
                        toggles: garment.part.toggles,
                        prompt: buildInpaintPrompt(finalPrompt, garment),
                        steps,
                        seed: Math.floor(Math.random() * 1e15),
                        denoise: 1.0,
                        unify: Number(cfg.inpaintUnify) || 0,
                        processRes: Number(cfg.inpaintRes) || 512,
                        maskBlur: Number(cfg.inpaintBlur) || 6,
                        maskOffset: Number(cfg.inpaintOffset) || 4,
                        bgOffset: Number(cfg.inpaintBgOffset) || -4,
                        growMask: Number(cfg.inpaintGrow) || 10,
                        coverOffset: Number(cfg.inpaintCoverOffset) || 4,
                        coverBlur: Number(cfg.inpaintCoverBlur) || 10,
                        tint: Number(cfg.inpaintTint) || 0,
                        targetColor: tintColorFor(garment.color),
                        prefix: 'chaite/seg_%timestamp%'
                    })
                } else {
                    // 整图改图：按比例缩放 + 浮点 denoise
                    wf = patchComfyEditWorkflow(loadComfyEditWorkflow(), {
                        image: imageName,
                        prompt: buildEditPrompt(finalPrompt),
                        negative,
                        negCfg: cfg.negCfg,
                        width: sizeObj.width,
                        height: sizeObj.height,
                        steps,
                        denoise: pickEditDenoise(finalPrompt, cfg.denoise),
                        seed: Math.floor(Math.random() * 1e15),
                        prefix: 'chaite/edit_%timestamp%'
                    })
                }
            } else {
                wf = this.patchWorkflow(workflow, {
                    prompt: `${finalPrompt}${pickStyleSuffix(finalPrompt)}`,
                    negative,
                    size,
                    steps,
                    scale,
                    denoise,
                    negCfg: cfg.negCfg,
                    twoPass: cfg.twoPass === true,
                    mode: 'txt2img',
                    image: '',
                    loraText: this.buildLoraText(finalPrompt),
                    prefix: 'chaite/krea2_%timestamp%'
                })
            }
            const { files } = await this.runWorkflow(base, wf, timeoutMs)
            for (const file of files) buffers.push(await this.fetchImage(base, file))
        }
        log(`[ComfyDraw] 出图完成：${buffers.length} 张，prompt=${finalPrompt.slice(0, 60)}`)
        return buffers
    }
}

export const comfyDrawService = new ComfyUIService()
export default comfyDrawService
