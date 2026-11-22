/**
 * ComfyUI 绘图命令（移植自 napcat-plugin-play 的绘图/识图反推功能）
 *
 * 用法：
 *   #绘图 1024x768 一只在雨里的猫        （支持 1024x768 / 16:9 / 横图 / 3张 / x3）
 *   #改图 换成赛博朋克风格               （附图片或引用图片）
 *   #反推                                （附图片或引用图片，输出绘图提示词）
 *   #反推画 额外补充                      （先识图，再照着重画一张）
 */
import config from '../config/config.js'
import { isIgnoredBot } from '../src/utils/botFilter.js'
import { segment } from '../src/utils/messageParser.js'
import { comfyDrawService } from '../src/services/media/ComfyUIService.js'

/** 从消息段里取图片内容（http / base64 / 本地文件） */
async function fetchImageBuffer(source) {
    const value = typeof source === 'string' ? source : source?.url || source?.file || ''
    if (!value) return null
    if (value.startsWith('data:')) {
        const idx = value.indexOf(',')
        return idx >= 0 ? Buffer.from(value.slice(idx + 1), 'base64') : null
    }
    if (value.startsWith('base64://')) return Buffer.from(value.slice('base64://'.length), 'base64')
    if (/^https?:\/\//i.test(value)) {
        const res = await fetch(value, { signal: AbortSignal.timeout(30000) })
        if (!res.ok) return null
        return Buffer.from(await res.arrayBuffer())
    }
    try {
        if (value.startsWith('file://')) return await import('node:fs').then(m => m.promises.readFile(value.slice(7)))
        if (value.startsWith('/')) return await import('node:fs').then(m => m.promises.readFile(value))
    } catch {
        return null
    }
    return null
}

/** 解析 1024x768 / 16:9 / 横图 / 竖图 / 方图 / 3张 / x3 / 批量3 */
function parseDrawOptions(text, cfg = {}) {
    let t = String(text || '')
    let width = 0
    let height = 0
    let count = 1

    const sizeHit = /(?:^|\s)(\d{2,4})\s*[x×*]\s*(\d{2,4})(?=\s|$)/i.exec(t)
    if (sizeHit) {
        width = parseInt(sizeHit[1], 10)
        height = parseInt(sizeHit[2], 10)
        t = t.replace(sizeHit[0], ' ')
    }
    if (!width || !height) {
        const ratioHit = /(?:^|\s)(?:比例\s*)?(\d{1,2})\s*[:：]\s*(\d{1,2})(?=\s|$)/.exec(t)
        if (ratioHit) {
            const rw = parseInt(ratioHit[1], 10)
            const rh = parseInt(ratioHit[2], 10)
            if (rw > 0 && rh > 0) {
                const base = 1024
                const longSide = Math.max(rw, rh)
                width = Math.round((rw / longSide) * base)
                height = Math.round((rh / longSide) * base)
                t = t.replace(ratioHit[0], ' ')
            }
        }
    }
    if (!width || !height) {
        if (/(横图|横版|横构图|横向)/.test(t)) {
            width = 1365
            height = 768
            t = t.replace(/(横图|横版|横构图|横向)/g, ' ')
        } else if (/(竖图|竖版|竖构图|竖向)/.test(t)) {
            width = 768
            height = 1365
            t = t.replace(/(竖图|竖版|竖构图|竖向)/g, ' ')
        } else if (/(方图|正方形|方形)/.test(t)) {
            width = 1024
            height = 1024
            t = t.replace(/(方图|正方形|方形)/g, ' ')
        }
    }
    const countHit = /(?:^|\s)(?:批量|x|×)?\s*(\d{1,2})\s*张(?=\s|$)/.exec(t) || /(?:^|\s)x(\d{1,2})(?=\s|$)/i.exec(t)
    if (countHit) {
        const n = parseInt(countHit[1], 10)
        if (n >= 1) count = n
        t = t.replace(countHit[0], ' ')
    }
    const maxBatch = Math.min(9, Math.max(1, parseInt(cfg.maxBatch, 10) || 9))
    if (cfg.batchEnabled === false) count = 1
    count = Math.max(1, Math.min(maxBatch, count))
    t = t.replace(/\s{2,}/g, ' ').trim()
    return { prompt: t, width, height, count }
}

/** 拆负面提示词：--no xxx / -n xxx / 负面：xxx */
function parseNegativePrompt(text) {
    const raw = String(text || '')
    const m = /(?:^|\s)(?:--no|-no|-n|负面提示词|负面|negative)\s*[:：]?\s*([\s\S]+)$/i.exec(raw)
    if (!m) return { prompt: raw.trim(), negative: '' }
    return { prompt: raw.slice(0, m.index).trim(), negative: m[1].trim() }
}

export class ComfyDraw extends plugin {
    constructor() {
        super({
            name: 'AI-ComfyDraw',
            dsc: 'ComfyUI 本地绘图 / 识图反推（Krea2 + Qwen3-VL）',
            event: 'message',
            priority: 45,
            rule: [
                { reg: /^#?反推画\s*([\s\S]*)$/i, fnc: 'reverseDraw' },
                { reg: /^#?反推\s*$/i, fnc: 'caption' },
                { reg: /^#?(绘图|画图)\s+([\s\S]+)$/i, fnc: 'draw' },
                { reg: /^#?(改图|重绘)\s*([\s\S]*)$/i, fnc: 'redraw' }
            ]
        })
    }

    get cfg() {
        return config.get('features.comfyDraw') || {}
    }

    allowedGroup() {
        const e = this.e
        if (!e?.isGroup) return true
        const gid = String(e.group_id)
        const cfg = this.cfg
        const baseGroup = config.get('trigger.group') || {}

        // 黑白名单继承基础设置（trigger.group），本地配置非空时优先生效
        const whitelist = (
            Array.isArray(cfg.whitelistGroups) && cfg.whitelistGroups.length > 0
                ? cfg.whitelistGroups
                : baseGroup.whitelistGroups || []
        ).map(String)
        const blacklist = (
            Array.isArray(cfg.blacklistGroups) && cfg.blacklistGroups.length > 0
                ? cfg.blacklistGroups
                : baseGroup.blacklistGroups || []
        ).map(String)

        if (blacklist.includes(gid)) return false
        if (cfg.whitelistOnly === false) return true
        if (whitelist.length === 0) return true
        return whitelist.includes(gid)
    }

    async collectImages() {
        const e = this.e
        const list = []
        for (const seg of e.message || []) {
            if (seg?.type === 'image') list.push(seg)
        }
        if (list.length === 0) {
            try {
                const reply = await e.getReply?.()
                for (const seg of reply?.message || []) {
                    if (seg?.type === 'image') list.push(seg)
                }
            } catch {
                /* 引用消息取不到就算了 */
            }
        }
        return list
    }

    async firstImageBuffer() {
        const images = await this.collectImages()
        for (const img of images) {
            const buffer = await fetchImageBuffer(img)
            if (buffer && buffer.length > 512) return buffer
        }
        return null
    }

    getRecallDelay() {
        const autoRecall = config.get('basic.autoRecall')
        return autoRecall?.enabled === true ? autoRecall.delay || 60 : 0
    }

    async draw() {
        if (isIgnoredBot(this.e)) return false
        const e = this.e
        if (this.cfg.enabled === false) return false
        if (!this.allowedGroup()) {
            await e.reply('本群未开启绘图', true)
            return true
        }
        const raw = String(e.msg || '')
            .replace(/^#?(绘图|画图)\s+/i, '')
            .trim()
        if (!raw) {
            await e.reply('用法：#绘图 [尺寸] [张数] 提示词，例如 #绘图 1024x768 一只猫', true)
            return true
        }
        const withNeg = parseNegativePrompt(raw)
        const opts = parseDrawOptions(withNeg.prompt, this.cfg)
        if (!opts.prompt) {
            await e.reply('提示词不能为空', true)
            return true
        }
        return this.generate({
            prompt: opts.prompt,
            negative: withNeg.negative,
            size: opts.width && opts.height ? `${opts.width}x${opts.height}` : undefined,
            count: opts.count,
            imageBuffer: await this.firstImageBuffer()
        })
    }

    async redraw() {
        if (isIgnoredBot(this.e)) return false
        const e = this.e
        if (this.cfg.enabled === false) return false
        if (!this.allowedGroup()) {
            await e.reply('本群未开启绘图', true)
            return true
        }
        const raw = String(e.msg || '')
            .replace(/^#?(改图|重绘)\s*/i, '')
            .trim()
        const imageBuffer = await this.firstImageBuffer()
        if (!imageBuffer) {
            await e.reply('改图需要附带一张图片，或引用一张图片', true)
            return true
        }
        const withNeg = parseNegativePrompt(raw)
        const opts = parseDrawOptions(withNeg.prompt, this.cfg)
        return this.generate({
            prompt: opts.prompt || '保持原图内容，优化细节',
            negative: withNeg.negative,
            size: opts.width && opts.height ? `${opts.width}x${opts.height}` : undefined,
            count: opts.count,
            imageBuffer
        })
    }

    async caption() {
        if (isIgnoredBot(this.e)) return false
        const e = this.e
        if (this.cfg.enabled === false || this.cfg.captionEnabled === false) return false
        if (!this.allowedGroup()) {
            await e.reply('本群未开启绘图', true)
            return true
        }
        const imageBuffer = await this.firstImageBuffer()
        if (!imageBuffer) {
            await e.reply('发一张图（或引用一张图），再发 #反推', true)
            return true
        }
        try {
            const { narrative, prompt } = await comfyDrawService.caption({ imageBuffer })
            const text =
                narrative && prompt && prompt !== narrative
                    ? `${prompt}\n\n—— 原描述 ——\n${narrative}`
                    : prompt || narrative
            const source = narrative ? '本地 Qwen3-VL' : 'DeepSeek 视觉'
            await e.reply(`${text.slice(0, 1500)}\n\n（识图来源：${source}）`, true, {
                recallMsg: this.getRecallDelay()
            })
        } catch (err) {
            logger.warn('[ComfyDraw] 识图反推失败:', err.message)
            await e.reply(`识图失败：${err.message}`, true)
        }
        return true
    }

    async reverseDraw() {
        if (isIgnoredBot(this.e)) return false
        const e = this.e
        if (this.cfg.enabled === false || this.cfg.captionEnabled === false) return false
        if (this.cfg.reverseDrawEnabled === false) {
            await e.reply('反推画未开启', true)
            return true
        }
        if (!this.allowedGroup()) {
            await e.reply('本群未开启绘图', true)
            return true
        }
        const raw = String(e.msg || '')
            .replace(/^#?反推画\s*/i, '')
            .trim()
        const imageBuffer = await this.firstImageBuffer()
        if (!imageBuffer) {
            await e.reply('反推画需要附带一张图片，或引用一张图片', true)
            return true
        }
        const opts = parseDrawOptions(raw, this.cfg)
        try {
            const { prompt } = await comfyDrawService.caption({ imageBuffer })
            const finalPrompt = opts.prompt ? `${prompt}, ${opts.prompt}` : prompt
            const shownPrompt = finalPrompt.length > 800 ? finalPrompt.slice(0, 800) + '…' : finalPrompt
            const sizeText = opts.width && opts.height ? ` ${opts.width}x${opts.height}` : ''
            return this.generate({
                prompt: finalPrompt,
                size: opts.width && opts.height ? `${opts.width}x${opts.height}` : undefined,
                // 反推画固定只画一张，批量子句不参与（避免一句话画多张）
                count: 1,
                imageBuffer: null,
                statusText: `🔍 反推提示词：\n${shownPrompt}\n\n🎨 正在绘制${sizeText}，约 1~3 分钟...`
            })
        } catch (err) {
            logger.warn('[ComfyDraw] 反推画失败:', err.message)
            await e.reply(`反推画失败：${err.message}`, true)
            return true
        }
    }

    async generate({ prompt, imageBuffer, size, count, negative, statusText }) {
        const e = this.e
        if (!comfyDrawService.enabled) return false
        const sizeText = size ? ` ${size}` : ''
        const status = statusText || `🎨 正在绘制${imageBuffer ? '（参考图改图）' : sizeText}，约 1~3 分钟...`
        await e.reply(status, true)
        try {
            const buffers = await comfyDrawService.generate({
                prompt,
                imageBuffer,
                size,
                count: Number(count) || Number(this.cfg.count) || 1,
                negative: negative || undefined
            })
            if (!buffers.length) {
                await e.reply('出图失败：没有拿到图片', true)
                return true
            }
            const recallMsg = this.getRecallDelay()
            for (const buffer of buffers) {
                await e.reply(segment.image(buffer), false, { recallMsg })
            }
        } catch (err) {
            logger.warn('[ComfyDraw] 绘图失败:', err.message)
            await e.reply(`绘图失败：${err.message}`, true)
        }
        return true
    }
}
