import config from '../config/config.js'
import { isIgnoredBot } from '../src/utils/botFilter.js'
import { cleanCQCode, parseUserMessage, segment } from '../src/utils/messageParser.js'
import { isMessageProcessed, markMessageProcessed, isSelfMessage } from '../src/utils/messageDedup.js'
import { renderService } from '../src/services/media/RenderService.js'
import { ensureScopeManager } from '../src/services/scope/ScopeManager.js'
import { checkTriggerAccess, sendForwardMsg } from '../src/utils/platformAdapter.js'
import { statsService } from '../src/services/stats/StatsService.js'
import { StandardBotApi } from '../src/core/platform/index.js'
import { emojiThiefService } from './EmojiThief.js'
import { convertAtMentions } from '../src/utils/mentionAt.js'
import { getRecentQQBotMessages } from '../src/services/storage/MessageCache.js'
import {
    splitMessage as splitMessageNatural,
    splitIntoSentences as splitIntoSentencesNatural,
    sendSegmentedMessage
} from '../src/utils/messageSegment.js'

async function getBymGroupContextMessages(e, groupId, limit = 15) {
    const api = StandardBotApi.fromContext({ event: e, bot: e?.bot || globalThis.Bot })
    if (api.isQQBot) {
        return getRecentQQBotMessages(groupId, limit + 1, e._raw_group_id)
            .filter(message => String(message.message_id) !== String(e.message_id || ''))
            .slice(-limit)
            .map(message => ({
                nickname: message.nickname || message.userId || '用户',
                userId: message.userId,
                content: message.content,
                timestamp: message.timestamp
            }))
            .filter(message => message.content && message.content.trim())
    }
    let group = e.group
    if (!group) {
        try {
            group = api.group(groupId)
        } catch {
            group = null
        }
    }
    if (group && typeof group.getChatHistory === 'function') {
        try {
            const initialSequence = e?.seq ?? e?.message_id ?? 0
            const sequence = api.isQQBot ? initialSequence : Number(initialSequence) || 0
            const history = await group.getChatHistory(sequence, Math.min(limit + 1, 20))
            const messages = (history || [])
                .filter(msg => String(msg.message_id || '') !== String(e.message_id || ''))
                .map(msg => {
                    const content = (msg.message || [])
                        .filter(part => part.type === 'text')
                        .map(part => part.text || '')
                        .join('')
                    return {
                        nickname: msg.sender?.card || msg.sender?.nickname || msg.sender?.user_id || '用户',
                        userId: msg.sender?.user_id,
                        content,
                        timestamp: msg.time ? msg.time * 1000 : Date.now()
                    }
                })
                .filter(msg => msg.content && msg.content.trim())
                .slice(-limit)
            if (messages.length > 0) return messages
        } catch (err) {
            logger.debug('[BYM] Bot API 获取群聊上下文失败:', err.message)
        }
    }

    const { memoryManager } = await import('../src/services/storage/MemoryManager.js')
    await memoryManager.init()
    return (memoryManager.getGroupMessageBuffer(groupId) || []).slice(-limit)
}

/**
 * 伪人模式 (BYM - Be Yourself Mode)
 * 让Bot像真人一样随机回复消息
 * 支持继承用户/群组独立人格配置
 */
export class bym extends plugin {
    constructor() {
        super({
            name: 'AI-伪人模式',
            dsc: 'AI伪人模式',
            event: 'message.group', // 仅群聊消息，避免私聊和其他事件触发
            priority: 6000,
            rule: [
                {
                    reg: '', // 匹配所有群聊消息，由内部逻辑判断
                    fnc: 'bym',
                    log: false
                }
            ]
        })
    }

    /**
     * 伪人模式触发logic
     */
    async bym() {
        if (isIgnoredBot(this.e)) return false
        const e = this.e
        // 与主聊天一致的忽略名单（刷屏游戏机器人等）
        const bymIgnoreUsers = (config.get('trigger.ignoreUsers') || []).map(String)
        if (bymIgnoreUsers.includes(String(e.user_id))) {
            logger.debug('[BYM] 忽略名单用户，跳过')
            return false
        }
        if (isSelfMessage(e)) {
            return false
        }
        if (
            e.post_type === 'notice' ||
            e.notice_type ||
            e.sub_type === 'reaction' ||
            e.sub_type === 'emoji_like' ||
            e.sub_type === 'msg_emoji_like'
        ) {
            return false
        }
        if (!e.msg && (!e.message || e.message.length === 0)) {
            return false
        }
        if (isMessageProcessed(e)) {
            return false
        }
        const globalEnabled = config.get('bym.enable')
        let enabled = globalEnabled
        let groupBymConfig = null
        let cachedGroupSettings = null // 缓存群组设置，避免重复查询

        // 检查群组独立设置
        if (e.isGroup && e.group_id) {
            try {
                const groupId = String(e.group_id)
                const scopeManager = await ensureScopeManager()
                cachedGroupSettings = await scopeManager.getGroupSettings(groupId)
                const groupFeatures = cachedGroupSettings?.settings || {}

                // 保存群组配置供后续使用
                groupBymConfig = groupFeatures

                // 如果群组有独立设置，使用群组设置
                if (groupFeatures.bymEnabled !== undefined) {
                    enabled = groupFeatures.bymEnabled
                    logger.debug(`[BYM] 使用群组独立设置: ${enabled}`)
                }
            } catch (err) {
                logger.debug('[BYM] 获取群组设置失败:', err.message)
            }
        }

        if (!enabled) {
            return false
        }
        const triggerCfg = config.get('trigger') || {}
        const userId = String(e.user_id || e.sender?.user_id || '')
        const groupId = e.group_id ? String(e.group_id) : ''
        if (!checkTriggerAccess(userId, groupId, triggerCfg)) {
            logger.debug(`[BYM] 黑白名单检查未通过: userId=${userId}, groupId=${groupId}`)
            return false
        }

        if (e.atBot) {
            return false
        }
        const cmdPrefix = config.get('basic.commandPrefix') || '#ai'
        const triggerPrefixes = triggerCfg.prefixes || []
        const allPrefixes = [cmdPrefix, '#', ...triggerPrefixes].filter(Boolean)
        const rawMsg = (e.msg || '').trim()
        if (allPrefixes.some(p => rawMsg.startsWith(p))) {
            return false
        }
        const processImage = config.get('bym.processImage') !== false // 默认处理图片
        const hasImage = (e.img && e.img.length > 0) || (e.message && e.message.some(m => m.type === 'image'))
        if (!processImage && hasImage) {
            logger.debug('[BYM] 跳过: 消息包含图片且未启用图片处理')
            return false
        }
        e.toICQQ = true
        // 继承群组的关键词配置（不使用独立的bym.nicknames）
        const globalKeywords = triggerCfg.keywords || []
        const allKeywords = [...new Set(globalKeywords)].filter(n => n && n.trim())

        let forceTriggered = false
        let matchedKeyword = ''
        if (allKeywords.length > 0 && rawMsg) {
            for (const keyword of allKeywords) {
                // 支持关键词在消息任意位置（如 "xx小喵xx" 匹配 "小喵"）
                if (rawMsg.includes(keyword)) {
                    forceTriggered = true
                    matchedKeyword = keyword
                    logger.debug(`[BYM] 关键词触发: 匹配到 "${keyword}" 在消息 "${rawMsg.substring(0, 30)}..."`)
                    break
                }
            }
        }
        if (!forceTriggered) {
            let probabilityRaw =
                groupBymConfig?.bymProbability !== undefined
                    ? groupBymConfig.bymProbability
                    : config.get('bym.probability')
            let probability = probabilityRaw
            logger.debug(
                `[BYM] probability原始值: ${probabilityRaw}, 类型: ${typeof probabilityRaw}, 来源: ${groupBymConfig?.bymProbability !== undefined ? '群组配置' : '全局配置'}`
            )

            if (probability === undefined || probability === null || isNaN(Number(probability))) {
                probability = 0.02
            } else {
                probability = Number(probability)
                if (probability > 1) {
                    probability = probability / 100
                    logger.debug(`[BYM] 检测到百分比格式，已转换: ${probabilityRaw} -> ${probability}`)
                }
            }
            probability = Math.max(0, Math.min(1, probability))
            if (probability === 0) {
                logger.debug('[BYM] 概率为0，不触发')
                return false
            }

            const randomValue = Math.random()
            logger.debug(`[BYM] 触发判定: random=${randomValue.toFixed(4)}, probability=${probability}`)

            if (randomValue > probability) {
                return false
            }
            logger.debug(`[BYM] 概率触发成功: random=${randomValue.toFixed(4)} <= probability=${probability}`)
        } else {
            logger.debug(`[BYM] 关键词触发: "${matchedKeyword}"`)
        }

        // 外层 catch 的失败统计需要这两个变量，故提升到 try 块之外声明
        let bymStartTimeTotal = null
        let bymModel = ''

        try {
            markMessageProcessed(e)
            logger.debug('[BYM] 伪人模式触发')
            bymStartTimeTotal = Date.now()
            const { LlmService: llmService } = await import('../src/services/llm/LlmService.js')
            const groupBymModel = groupBymConfig?.bymModel
            const configBymModel = config.get('bym.model')
            bymModel =
                groupBymModel && typeof groupBymModel === 'string' && groupBymModel.trim()
                    ? groupBymModel
                    : configBymModel && typeof configBymModel === 'string' && configBymModel.trim()
                      ? configBymModel
                      : llmService.getModel()

            if (groupBymModel && groupBymModel.trim()) {
                logger.debug(`[BYM] 使用群组独立模型: ${bymModel}`)
            }

            const bymGroupIdForClient = e.group_id ? String(e.group_id) : undefined
            const client = await llmService.getChatClient({
                enableTools: false,
                model: bymModel,
                groupId: bymGroupIdForClient
            })

            if (!client) {
                logger.warn('[BYM] 无法获取聊天客户端')
                return false
            }

            // 如果这条消息明确是在 @ 别人（不是机器人），伪人模式不要插嘴
            const bymBotId = String(e.self_id || e.bot?.uin || e.bot?.self_id || '')
            const atSegs = (Array.isArray(e.message) ? e.message : []).filter(
                seg => seg?.type === 'at' && seg?.data?.all !== true && seg?.data?.all !== 'all'
            )
            const atOthersOnly =
                atSegs.length > 0 &&
                !atSegs.some(seg =>
                    [seg.qq, seg.data?.qq, seg.data?.user_id, seg.user_id].some(
                        v => v !== undefined && v !== null && String(v) === bymBotId
                    )
                )
            if (atOthersOnly) {
                logger.debug('[BYM] 消息在 @ 别人，跳过插嘴')
                return false
            }

            // Get message text：不能用 cleanCQCode 直接洗 e.msg，否则 @xx 会被整段删掉，
            // 模型就不知道这句话是在叫别人。这里走 parseUserMessage，把 @ 展开成
            // [提及用户 QQ:xxx 群名片:"..."] 再交给模型。
            let messageText = ''
            try {
                const parsed = await parseUserMessage(e)
                messageText = (parsed?.text || '').trim()
            } catch (err) {
                logger.debug('[BYM] 解析消息失败，回退 cleanCQCode:', err.message)
            }
            if (!messageText.trim()) messageText = cleanCQCode(e.msg || '')
            if (!messageText.trim()) {
                return false
            }
            let systemPrompt = ''
            let bymGroupContextText = ''
            let scopePresetId = null
            const inheritPersonality = config.get('bym.inheritPersonality') !== false
            if (inheritPersonality) {
                try {
                    const scopeManager = await ensureScopeManager()

                    const scopeUserId = String(e.user_id || e.sender?.user_id)
                    const defaultBymPrompt =
                        config.get('bym.systemPrompt') ||
                        '你是一个真实的人类用户，正在和朋友们聊天。请用简短、自然、口语化的方式回复，就像真人一样。不要说你是AI。'

                    // 使用新的群组有效配置方法（包含继承和群组知识库）
                    if (groupId || e.group_id) {
                        // 复用之前缓存的群组设置，避免重复查询
                        const groupSettings = cachedGroupSettings || (await scopeManager.getGroupSettings(groupId))
                        const bymPresetId = groupSettings?.settings?.bymPresetId
                        const bymPrompt = groupSettings?.settings?.bymPrompt

                        if (bymPresetId && bymPresetId !== '__default__') {
                            if (bymPresetId === '__custom__' && bymPrompt) {
                                // 使用自定义伪人提示词
                                systemPrompt = bymPrompt
                                logger.debug(`[BYM] 使用群组自定义伪人提示词`)
                            } else {
                                // 使用指定的预设
                                try {
                                    const { presetManager } = await import('../src/services/preset/PresetManager.js')
                                    await presetManager.init()
                                    const preset = presetManager.get(bymPresetId)
                                    if (preset?.systemPrompt) {
                                        systemPrompt = preset.systemPrompt
                                        scopePresetId = bymPresetId
                                        logger.debug(
                                            `[BYM] 使用群组伪人预设: ${bymPresetId} (${preset.name || bymPresetId})`
                                        )
                                    }
                                } catch (err) {
                                    logger.warn(`[BYM] 加载伪人预设 ${bymPresetId} 失败:`, err.message)
                                }
                            }
                        }

                        // 只调用一次 getEffectiveBymConfig，同时获取 systemPrompt 和知识库
                        const effectiveGroupId = groupId || String(e.group_id)
                        const bymConfig = await scopeManager.getEffectiveBymConfig(effectiveGroupId, scopeUserId, {
                            defaultPrompt: systemPrompt ? '' : defaultBymPrompt,
                            includeKnowledge: true
                        })

                        // 如果没有专用伪人预设，使用群组有效配置的 systemPrompt
                        if (!systemPrompt) {
                            systemPrompt = bymConfig.systemPrompt || defaultBymPrompt
                            scopePresetId = bymConfig.presetId

                            // 记录配置来源
                            if (bymConfig.sources.length > 0) {
                                logger.debug(`[BYM] 配置来源: ${bymConfig.sources.join(' -> ')}`)
                            }
                        }

                        // 添加群组知识库（无论使用哪种预设都添加）
                        if (bymConfig.knowledgePrompt) {
                            systemPrompt += '\n\n' + bymConfig.knowledgePrompt
                            logger.debug(
                                `[BYM] 已添加群组知识库 (${bymConfig.knowledgeIds.length} 个, ${bymConfig.knowledgePrompt.length} 字符)`
                            )
                        }
                    } else {
                        // 私聊场景：使用原有逻辑
                        const effectiveSettings = await scopeManager.getEffectiveSettings(null, scopeUserId, {
                            isPrivate: true
                        })

                        if (effectiveSettings?.presetId) {
                            scopePresetId = effectiveSettings.presetId
                            const { presetManager } = await import('../src/services/preset/PresetManager.js')
                            await presetManager.init()
                            const preset = presetManager.get(scopePresetId)
                            if (preset?.systemPrompt) {
                                systemPrompt = preset.systemPrompt
                                logger.debug(`[BYM] 使用作用域预设: ${scopePresetId} (${preset.name || scopePresetId})`)
                            }
                        }

                        if (!systemPrompt) {
                            const independentResult = await scopeManager.getIndependentPrompt(
                                null,
                                scopeUserId,
                                defaultBymPrompt
                            )
                            systemPrompt = independentResult.prompt
                            if (independentResult.isIndependent) {
                                logger.debug(`[BYM] 使用独立人格 (来源: ${independentResult.source})`)
                            }
                        }
                    }

                    // 添加伪人模式行为指导
                    systemPrompt +=
                        '\n\n【伪人模式行为指导】\n请用简短、自然、口语化的方式回复，就像真人聊天一样。回复要简洁（通常1-2句话），可以使用语气词和网络用语。'

                    // 如果有预设且群组没有独立知识库，尝试加载预设知识库
                    if (scopePresetId && !systemPrompt.includes('【群组知识库】')) {
                        try {
                            const { knowledgeService } = await import('../src/services/storage/KnowledgeService.js')
                            await knowledgeService.init()
                            const knowledgePrompt = knowledgeService.buildKnowledgePrompt(scopePresetId, {
                                maxLength: config.get('knowledge.maxLength') || 8000,
                                includeTriples: config.get('knowledge.includeTriples') !== false
                            })
                            if (knowledgePrompt) {
                                systemPrompt += '\n\n' + knowledgePrompt
                                logger.debug(`[BYM] 已添加预设知识库 (${knowledgePrompt.length} 字符)`)
                            }
                        } catch (err) {
                            logger.debug('[BYM] 加载预设知识库失败:', err.message)
                        }
                    }
                } catch (err) {
                    logger.debug('[BYM] 获取人格配置失败，使用默认:', err.message)
                    systemPrompt =
                        config.get('bym.systemPrompt') ||
                        '你是一个真实的人类用户，正在和朋友们聊天。请用简短、自然、口语化的方式回复，就像真人一样。不要说你是AI。'
                }
            } else {
                // 检查全局伪人预设配置
                const globalBymPresetId = config.get('bym.presetId')
                if (globalBymPresetId) {
                    try {
                        const { presetManager } = await import('../src/services/preset/PresetManager.js')
                        await presetManager.init()
                        const preset = presetManager.get(globalBymPresetId)
                        if (preset?.systemPrompt) {
                            systemPrompt = preset.systemPrompt
                            logger.debug(
                                `[BYM] 使用全局伪人预设: ${globalBymPresetId} (${preset.name || globalBymPresetId})`
                            )
                        }
                    } catch (err) {
                        logger.warn(`[BYM] 加载全局伪人预设 ${globalBymPresetId} 失败:`, err.message)
                    }
                }
                // 如果没有预设或预设加载失败，使用系统提示词
                if (!systemPrompt) {
                    systemPrompt =
                        config.get('bym.systemPrompt') ||
                        '你是一个真实的人类用户，正在和朋友们聊天。请用简短、自然、口语化的方式回复，就像真人一样。不要说你是AI。'
                }
            }
            const presetMap = config.get('bym.presetMap') || {}
            for (const [keyword, presetId] of Object.entries(presetMap)) {
                if (messageText.includes(keyword)) {
                    const presetPrompt = llmService.getSystemPrompt(presetId)
                    if (presetPrompt) {
                        systemPrompt = presetPrompt
                        logger.debug(`[BYM] 匹配关键词 "${keyword}", 使用预设 "${presetId}"`)
                    }
                    break
                }
            }

            // 提取图片URL（移到外部以便后续使用）
            let imageUrls = []
            if (processImage && hasImage) {
                imageUrls = [...(e.img || [])]
                // 也从 message 中提取图片
                if (e.message) {
                    for (const m of e.message) {
                        if (m.type === 'image') {
                            const url = m.url || m.file || m.data?.url
                            if (url && !imageUrls.includes(url)) {
                                imageUrls.push(url)
                            }
                        }
                    }
                }

                if (imageUrls.length > 0) {
                    logger.debug(`[BYM] 处理图片消息: ${imageUrls.length} 张图片`)
                }
            }

            if (e.sender) {
                systemPrompt += `\n当前对话者: ${e.sender.card || e.sender.nickname || '未知用户'}`
            }
            if (e.group_name) {
                systemPrompt += `\n当前群聊: ${e.group_name}`
            }

            // 获取温度和maxTokens：优先群组配置 > 全局配置
            const bymTemperature =
                groupBymConfig?.bymTemperature !== undefined
                    ? groupBymConfig.bymTemperature
                    : config.get('bym.temperature') || 0.9
            // 回复长度映射（short/medium/long -> maxTokens），群组显式 maxTokens 优先
            const replyLengthMap = { short: 120, medium: 200, long: 320 }
            const bymReplyLength = groupBymConfig?.bymReplyLength
            const bymMaxTokens =
                groupBymConfig?.bymMaxTokens !== undefined
                    ? groupBymConfig.bymMaxTokens
                    : bymReplyLength && replyLengthMap[bymReplyLength]
                      ? replyLengthMap[bymReplyLength]
                      : config.get('bym.maxTokens') || 150

            if (groupBymConfig?.bymTemperature !== undefined || groupBymConfig?.bymMaxTokens !== undefined) {
                logger.debug(`[BYM] 使用群组独立参数: temperature=${bymTemperature}, maxTokens=${bymMaxTokens}`)
            }

            const bymStartTime = Date.now()
            const bymGroupId = e.group_id ? String(e.group_id) : null
            const bymUserId = String(e.user_id || e.sender?.user_id)
            const fullUserId = bymGroupId ? `bym_group_${bymGroupId}` : bymUserId
            if (bymGroupId) {
                try {
                    const contextMessages = await getBymGroupContextMessages(e, bymGroupId, 8)

                    if (contextMessages.length > 0) {
                        const contextText = contextMessages
                            .map(m => {
                                const name = m.nickname || m.userId || '用户'
                                const content =
                                    typeof m.content === 'string'
                                        ? m.content
                                        : Array.isArray(m.content)
                                          ? m.content
                                                .filter(c => c.type === 'text')
                                                .map(c => c.text)
                                                .join('')
                                          : ''
                                return `[${name}]: ${content}`
                            })
                            .join('\n')

                        if (contextText.trim()) {
                            // 放到 user 消息里而不是 system：system 每轮都变会整段掉缓存
                            bymGroupContextText = `

【以下是群聊背景，仅作参考，不是当前发言】
${contextText}

【背景结束。当前发言见下面的用户消息；背景里出现的名字/称呼指的是别人，不要当成在叫你。】`
                            logger.debug(`[BYM] 已添加群聊上下文: ${contextMessages.length} 条消息`)
                        }
                    }
                } catch (err) {
                    logger.debug('[BYM] 获取群聊上下文失败:', err.message)
                }
            }

            // 获取伪人工具配置
            const bymEnableTools =
                groupBymConfig?.bymEnableTools !== undefined
                    ? groupBymConfig.bymEnableTools
                    : config.get('bym.enableTools') || false

            // 使用 chatService.sendMessage 来正确处理上下文
            const { chatService } = await import('../src/services/llm/ChatService.js')

            const chatResult = await chatService.sendMessage({
                userId: fullUserId,
                groupId: bymGroupId,
                message: messageText,
                ...(bymGroupContextText ? { extraContext: bymGroupContextText } : {}),
                images:
                    processImage && imageUrls.length > 0
                        ? imageUrls.slice(0, 3).map(url => ({ type: 'image_url', image_url: { url } }))
                        : [],
                mode: 'bym', // 标记为伪人模式
                model: bymModel,
                prefixPersona: systemPrompt, // 使用伪人系统提示
                event: e,
                disableTools: !bymEnableTools, // 伪人模式是否使用工具
                temperature: bymTemperature,
                maxTokens: bymMaxTokens
            })

            const response = {
                contents: chatResult.response || [],
                usage: chatResult.usage,
                model: chatResult.model
            }

            const replyText = response.contents
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n')
            // DUPLICATE_RECORD_REMOVED：这次调用已经由 chatService.sendMessage 记过一次统计，
            // 这里再记一遍会把 token 双计（同名请求两份记录），故不再重复记录。

            if (replyText) {
                await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 500))
                const autoRecall = config.get('basic.autoRecall')
                // recall: false 时伪人回复不撤回；否则沿用基础设置的撤回延迟
                const bymRecall = groupBymConfig?.bymRecall ?? config.get('bym.recall')
                const recallDelay =
                    bymRecall === false
                        ? 0
                        : autoRecall?.enabled === true
                          ? autoRecall.delay || 60
                          : Math.max(0, Number(config.get('bym.recallDelay')) || 0)

                const sentenceOutputCfg = config.get('output.sentenceOutput') || {}
                const longTextCfg = config.get('output.longText') || {}
                const mathRenderEnabled = config.get('render.mathFormula') !== false

                let handled = false

                // 数学公式渲染优先：伪人回复含公式时渲染为图片
                if (mathRenderEnabled) {
                    const mathDetection = renderService.detectMathFormulas(replyText)
                    if (mathDetection.hasMath && mathDetection.confidence !== 'low') {
                        try {
                            const imageBuffer = await renderService.renderMathContent(replyText, {
                                theme: config.get('render.theme') || 'light',
                                width: config.get('render.width') || 800
                            })
                            await this.reply(segment.image(imageBuffer), false, { recallMsg: recallDelay })
                            handled = true
                        } catch {}
                    }
                }

                // 换行分条：模型输出多行时逐条发（短回复也拆），和主聊天链路保持一致
                if (!handled) {
                    const lines = replyText.split(/\n+/).map(t => t.trim()).filter(Boolean)
                    if (lines.length > 1 && lines.every(l => l.length <= 500)) {
                        const maxSeg = Math.max(1, Math.min(12, Number(sentenceOutputCfg.maxSegments) || 8))
                        const toSend =
                            lines.length > maxSeg
                                ? [...lines.slice(0, maxSeg - 1), lines.slice(maxSeg - 1).join(' ').slice(0, 500)]
                                : lines
                        for (let i = 0; i < toSend.length; i++) {
                            await this.reply(convertAtMentions(toSend[i], { e, segment }), false, {
                                recallMsg: recallDelay
                            })
                            if (i < toSend.length - 1) {
                                const minD = Number(sentenceOutputCfg.minDelay) || 800
                                const maxD = Math.max(minD + 100, Number(sentenceOutputCfg.maxDelay) || 1600)
                                await new Promise(r => setTimeout(r, minD + Math.floor(Math.random() * (maxD - minD))))
                            }
                        }
                        handled = true
                    }
                }

                // 统一拟人发送：短回复单条；中等长度按语义分段逐条；超长折叠为卡片
                if (!handled) {
                    const enableSegmented = sentenceOutputCfg.enabled
                    const foldLimit = Math.max(longTextCfg.threshold || 500, 500)
                    if (enableSegmented || replyText.length > 140) {
                        const result = await sendSegmentedMessage(this, replyText, {
                            quote: false,
                            decorate: t => convertAtMentions(t, { e, segment }),
                            shortLimit: 140,
                            foldLimit,
                            foldHandler: async fullText => {
                                if (longTextCfg.enabled === false) return false
                                const mode = longTextCfg.mode || 'forward'
                                if (mode === 'image') {
                                    try {
                                        const { renderService } = await import('../src/services/media/RenderService.js')
                                        const imageBuffer = await renderService.renderMarkdownToImage({
                                            markdown: fullText,
                                            title: 'AI 回复',
                                            icon: '💬',
                                            theme: config.get('render.theme') || 'light',
                                            width: config.get('render.width') || 800
                                        })
                                        await this.reply(segment.image(imageBuffer), false, { recallMsg: recallDelay })
                                        return true
                                    } catch {
                                        return false
                                    }
                                }
                                if (mode === 'forward' || mode === 'auto') {
                                    try {
                                        // 转发卡片内的段落按语义切片，替换原先只按空行拆分的硬规则
                                        const paragraphs = splitMessageNatural(fullText, {
                                            chunkSize: 300,
                                            maxChunk: 500,
                                            mergeThreshold: 24
                                        })
                                        if (paragraphs.length > 0) {
                                            return await sendForwardMsg(
                                                e,
                                                longTextCfg.forwardTitle || 'AI 回复',
                                                paragraphs
                                            )
                                        }
                                    } catch {
                                        /* 转发失败回退逐条 */
                                    }
                                }
                                return false
                            },
                            replyOptions: { recallMsg: recallDelay }
                        })
                        if (result.folded || result.messageIds.length > 0) {
                            handled = true
                        }
                    }
                }

                // 默认直接发送
                if (!handled) {
                    await this.reply(convertAtMentions(replyText, { e, segment }), false, { recallMsg: recallDelay })
                }

                // 表情包小偷 - 伪人触发模式
                try {
                    // useEmoji: 群组设置 > 全局设置，关闭时不发表情
                    const bymUseEmoji =
                        groupBymConfig?.bymUseEmoji !== undefined
                            ? groupBymConfig.bymUseEmoji !== false
                            : config.get('bym.useEmoji') !== false
                    const emojiMsg = bymUseEmoji ? await emojiThiefService.tryTrigger(e, 'bym') : null
                    if (emojiMsg) {
                        await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 300))
                        await this.reply(emojiMsg)
                    }
                } catch (err) {
                    logger.debug('[BYM] 表情包触发失败:', err.message)
                }
            }

            return true
        } catch (error) {
            // 伪人模式需要"假装真人"，失败时不向用户发送任何提示，仅记录日志与失败统计
            logger.error('[BYM] Error:', error)
            try {
                await statsService.recordApiCall({
                    channelId: 'bym',
                    channelName: 'bym',
                    model: bymModel || '',
                    duration: bymStartTimeTotal ? Date.now() - bymStartTimeTotal : 0,
                    success: false,
                    error: error.message || String(error),
                    source: 'bym',
                    userId: e?.user_id ? String(e.user_id) : null,
                    groupId: e?.group_id ? String(e.group_id) : null
                })
            } catch (statsErr) {
                logger.debug('[BYM] 统计记录失败:', statsErr.message)
            }
            return false
        }
    }

    /**
     * 兼容入口：统一走 messageSegment 的语义分段实现。
     * @param {string} text - 待拆分文本
     * @returns {string[]} 句子数组
     */
    splitIntoSentences(text) {
        return splitIntoSentencesNatural(text)
    }
}
