import config from '../config/config.js'
import { isIgnoredBot } from '../src/utils/botFilter.js'
import { parseUserMessage, segment } from '../src/utils/messageParser.js'

/** 已拉过完整成员表的群（每进程每群一次） */
const chatWarmedGroups = new Set()
import { isDebugEnabled } from './Commands.js'
import {
    recordSentMessage,
    markMessageProcessed,
    startProcessingMessage,
    isMessageProcessed,
    isSelfMessage,
    isReplyToBotMessage,
    getBotIds
} from '../src/utils/messageDedup.js'
import { renderService } from '../src/services/media/RenderService.js'
import { cacheGroupMessage } from './GroupEvents.js'
import { isQQBotInstance } from '../src/core/platform/index.js'
import { emojiThiefService } from './EmojiThief.js'
import { chatService } from '../src/services/llm/ChatService.js'
import { memoryManager } from '../src/services/storage/MemoryManager.js'
import { statsService } from '../src/services/stats/StatsService.js'
import { ensureScopeManager } from '../src/services/scope/ScopeManager.js'
import { checkTriggerAccess, sendForwardMsg as platformSendForwardMsg } from '../src/utils/platformAdapter.js'
import { mcpManager } from '../src/mcp/McpManager.js'
import {
    splitMessage as splitMessageNatural,
    splitIntoSentences as splitIntoSentencesNatural,
    sendSegmentedMessage
} from '../src/utils/messageSegment.js'
import { setToolContext } from '../src/core/utils/toolAdapter.js'
import { conversationTracker } from '../src/services/llm/ConversationTracker.js'
import { contextManager } from '../src/services/llm/ContextManager.js'
import { toolApprovalService } from '../src/services/tools/ToolApprovalService.js'
import { presetManager } from '../src/services/preset/PresetManager.js'
import { errorNotifier } from '../src/services/ErrorNotifier.js'

export {
    recordSentMessage,
    markMessageProcessed,
    startProcessingMessage,
    isMessageProcessed,
    isSelfMessage,
    isReplyToBotMessage,
    getBotIds
}

// 群组触发配置缓存
const groupTriggerCache = new Map()
const CACHE_TTL = 60000

async function getGroupTriggerConfig(groupId) {
    if (!groupId) return {}
    const cacheKey = String(groupId)
    const cached = groupTriggerCache.get(cacheKey)
    if (cached && Date.now() - cached.time < CACHE_TTL) {
        return cached.config
    }
    try {
        const scopeManager = await ensureScopeManager()
        const groupSettings = await scopeManager.getGroupSettings(cacheKey)
        const settings = groupSettings?.settings || {}
        const cfg = {
            triggerMode: settings.triggerMode,
            customPrefix: settings.customPrefix,
            prefixPersonas: settings.prefixPersonas
        }
        groupTriggerCache.set(cacheKey, { config: cfg, time: Date.now() })
        return cfg
    } catch {
        return {}
    }
}

export class Chat extends plugin {
    constructor() {
        super({
            name: 'AI-Chat',
            dsc: 'AI对话功能',
            event: 'message',
            priority: 500,
            rule: [
                {
                    reg: '',
                    fnc: 'handleMessage',
                    log: false
                }
            ]
        })
    }

    /**
     * 统一消息处理入口
     */
    async handleMessage() {
        // 忽略被屏蔽的 Bot（避免同群双 Bot 重复回复）
        if (isIgnoredBot(this.e)) return false
        const e = this.e

        if (isSelfMessage(e)) return false

        // 忽略名单（例如在群里刷屏的游戏机器人），避免每条播报都触发一次 LLM
        const ignoreUsers = config.get('trigger.ignoreUsers') || []
        if (ignoreUsers.map(String).includes(String(e.user_id))) return false
        if (isMessageProcessed(e)) return false

        const approvalInput = toolApprovalService.resolveApproval(e.msg || '', {
            event: e,
            conversationId: contextManager.getConversationId(String(e.user_id), e.group_id ? String(e.group_id) : null),
            groupId: e.group_id,
            userId: e.user_id
        })
        if (approvalInput.handled) {
            if (approvalInput.message) await this.reply(approvalInput.message, true)
            return true
        }

        // QQBot 已在插件入口的全局 message 监听中完成一次缓存
        if (e.isGroup && e.message_id && !isQQBotInstance(e)) {
            try {
                cacheGroupMessage(e)
            } catch (err) {
                logger.debug('[Chat] 缓存群消息失败:', err.message)
            }
        }

        // 检查监听器是否启用
        const listenerEnabled = config.get('listener.enabled')
        if (listenerEnabled === false) {
            this.collectGroupMessage(e)
            return false
        }

        // 获取触发配置
        let triggerCfg = this.getTriggerConfig()

        // 群消息收集
        if (e.isGroup && e.group_id && triggerCfg.collectGroupMsg !== false) {
            this.collectGroupMessage(e)
        }

        // 检查系统命令
        const rawMsg = e.msg || ''
        const systemCmdPatterns = [
            /^#(结束对话|清除记忆|我的记忆|删除记忆|群聊总结|总结群聊|群消息总结|画像总结)/,
            /^#chatdebug/i,
            /^#ai/i
        ]
        for (const pattern of systemCmdPatterns) {
            if (pattern.test(rawMsg)) return false
        }

        // 检查#命令（排除触发前缀）
        const allowHashCmds = triggerCfg.allowHashCommands === true
        if (!allowHashCmds && /^#\S/.test(rawMsg)) {
            const cleanedForCheck = this.cleanAtBot(rawMsg)
            // 如果是触发前缀消息（如 #chat），不拦截
            const prefixes = triggerCfg.prefixes || []
            const isTriggerPrefix = prefixes.some(p => p && cleanedForCheck.startsWith(p))
            if (!isTriggerPrefix && /^#\S/.test(cleanedForCheck.trim())) return false
        }

        // 检查访问权限
        if (!this.checkAccess(triggerCfg)) return false

        // 检查群组独立黑白名单
        if (e.isGroup && e.group_id) {
            const groupAccess = await this.checkGroupAccess(e.group_id, e.user_id)
            if (!groupAccess.allowed) {
                logger.debug(`[Chat] 群组黑白名单拒绝: ${groupAccess.reason}`)
                return false
            }
        }

        // 获取群组独立配置
        if (e.isGroup && e.group_id) {
            const groupConfig = await getGroupTriggerConfig(e.group_id)
            if (groupConfig.triggerMode && groupConfig.triggerMode !== 'default') {
                const mode = groupConfig.triggerMode
                if (!triggerCfg.group) triggerCfg.group = {}
                triggerCfg.group.at = mode === 'at' || mode === 'all'
                triggerCfg.group.prefix = mode === 'prefix' || mode === 'all'
                triggerCfg.group.keyword = mode === 'all'
                triggerCfg.group.random = false
            }
            if (groupConfig.customPrefix) {
                if (!triggerCfg.prefixes) triggerCfg.prefixes = []
                if (!triggerCfg.prefixes.includes(groupConfig.customPrefix)) {
                    triggerCfg.prefixes = [groupConfig.customPrefix, ...triggerCfg.prefixes]
                }
            }
            if (Array.isArray(groupConfig.prefixPersonas) && groupConfig.prefixPersonas.length > 0) {
                const globalPrefixPersonas = triggerCfg.prefixPersonas || []
                triggerCfg.prefixPersonas = [...groupConfig.prefixPersonas, ...globalPrefixPersonas]
            }
        }

        // 检查触发条件
        const triggerResult = await this.checkTriggerWithTracking(triggerCfg)
        if (!triggerResult.triggered) return false

        // 标记消息正在处理
        if (!startProcessingMessage(e)) return false
        markMessageProcessed(e)
        e.toICQQ = true
        // 处理聊天
        return this.processChat(triggerResult.msg, {
            persona: triggerResult.persona,
            isPersonaPrefix: triggerResult.isPersonaPrefix
        })
    }

    /**
     * 获取触发配置
     */
    getTriggerConfig() {
        let triggerCfg = config.get('trigger')
        if (!triggerCfg?.private) {
            const listenerConfig = config.get('listener') || {}
            let prefixes = listenerConfig.triggerPrefix || ['#chat']
            if (typeof prefixes === 'string') prefixes = [prefixes]
            const triggerMode = listenerConfig.triggerMode || 'at'
            triggerCfg = {
                private: {
                    enabled: listenerConfig.privateChat?.enabled ?? true,
                    mode: listenerConfig.privateChat?.alwaysReply ? 'always' : 'prefix',
                    blacklistUsers: listenerConfig.blacklistUsers || [],
                    whitelistUsers: listenerConfig.whitelistUsers || []
                },
                group: {
                    enabled: listenerConfig.groupChat?.enabled ?? true,
                    at: ['at', 'both'].includes(triggerMode),
                    prefix: ['prefix', 'both'].includes(triggerMode),
                    keyword: triggerMode === 'both',
                    random: triggerMode === 'random',
                    randomRate: listenerConfig.randomReplyRate || 0.1,
                    replyBot: listenerConfig.groupChat?.replyBot ?? true,
                    blacklistUsers: listenerConfig.blacklistUsers || [],
                    whitelistUsers: listenerConfig.whitelistUsers || [],
                    blacklistGroups: listenerConfig.blacklistGroups || [],
                    whitelistGroups: listenerConfig.whitelistGroups || []
                },
                prefixes,
                keywords: listenerConfig.triggerKeywords || [],
                prefixPersonas: listenerConfig.prefixPersonas || [],
                collectGroupMsg: listenerConfig.groupChat?.collectMessages ?? true
            }
        }
        return JSON.parse(JSON.stringify(triggerCfg))
    }

    /**
     * 检查访问权限
     */
    checkAccess(cfg) {
        const e = this.e
        return checkTriggerAccess(e.user_id, e.isGroup ? e.group_id : null, cfg)
    }

    /**
     * 检查群组独立黑白名单
     * @param {string} groupId - 群组ID
     * @param {string} userId - 用户ID
     * @returns {Promise<{allowed: boolean, reason?: string}>}
     */
    async checkGroupAccess(groupId, userId) {
        if (!groupId) return { allowed: true }

        try {
            const scopeManager = await ensureScopeManager()
            const groupSettings = await scopeManager.getGroupSettings(String(groupId))
            const settings = groupSettings?.settings || {}

            if (settings.enabled === false) {
                return { allowed: false, reason: '本群已关闭AI响应' }
            }

            if (settings.chatEnabled === false) {
                return { allowed: false, reason: '本群已关闭AI对话功能' }
            }

            const listMode = settings.listMode || 'none'
            const blacklist = settings.blacklist || []
            const whitelist = settings.whitelist || []

            // 黑名单模式
            if (listMode === 'blacklist' && blacklist.includes(String(userId))) {
                return { allowed: false, reason: '您已被加入本群黑名单，无法使用AI功能' }
            }

            // 白名单模式
            if (listMode === 'whitelist' && !whitelist.includes(String(userId))) {
                return { allowed: false, reason: '本群已启用白名单模式，您不在白名单中' }
            }
        } catch (err) {
            logger.debug('[Chat] 检查群组黑白名单失败:', err.message)
        }

        return { allowed: true }
    }

    /**
     * 检查触发条件
     */
    checkTrigger(cfg) {
        const e = this.e
        const rawMsg = e.msg || ''

        // 私聊
        if (!e.isGroup) {
            const privateCfg = cfg.private || {}
            const mode = privateCfg.mode || 'prefix'

            // off 模式或禁用时完全关闭私聊触发；always 无条件触发；其余（含默认 prefix）需前缀匹配
            if (privateCfg.enabled === false || mode === 'off') return { triggered: false }

            // always 无需前缀
            if (mode === 'always') return { triggered: true, msg: rawMsg }

            // 前缀触发
            const prefixResult = this.checkPrefix(rawMsg, cfg.prefixes, cfg.prefixPersonas)
            if (prefixResult.matched) {
                return {
                    triggered: true,
                    msg: prefixResult.content,
                    persona: prefixResult.persona,
                    isPersonaPrefix: prefixResult.isPersonaPrefix
                }
            }
            return { triggered: false }
        }

        // 群聊
        const groupCfg = cfg.group || {}
        if (!groupCfg.enabled) return { triggered: false }
        const botId = e.self_id || e.bot?.uin || e.bot?.self_id || globalThis.Bot?.uin
        const botIdText = botId === undefined || botId === null ? '' : String(botId)
        const botIdHit = seg => {
            if (!seg || seg.type !== 'at') return false
            if (seg.data?.all === true || seg.data?.all === 'all') return true
            return [seg.qq, seg.data?.qq, seg.data?.user_id, seg.user_id].some(
                value => value !== undefined && value !== null && String(value) === botIdText
            )
        }
        const isAtBot = Boolean(e.atBot || e.atme || (botIdText && e.message?.some?.(botIdHit)))

        if (groupCfg.at && isAtBot) {
            const isReplyToBot = isReplyToBotMessage(e)
            const cleanedMsg = this.cleanAtBot(rawMsg)
            const finalMsg = cleanedMsg.trim() ? cleanedMsg : rawMsg
            if (!finalMsg.trim()) return { triggered: false }

            const replyBotEnabled = groupCfg.replyBot !== false
            if ((isReplyToBot && replyBotEnabled) || !isReplyToBot) {
                return { triggered: true, msg: finalMsg }
            }
        }

        // 引用机器人
        if (groupCfg.replyBot && e.source && !e.atBot && isReplyToBotMessage(e)) {
            return { triggered: true, msg: rawMsg }
        }

        // 前缀触发
        if (groupCfg.prefix) {
            const cleanedForPrefix = this.cleanAtBot(rawMsg)
            const result = this.checkPrefix(cleanedForPrefix, cfg.prefixes, cfg.prefixPersonas)
            if (result.matched) {
                return {
                    triggered: true,
                    msg: result.content,
                    persona: result.persona,
                    isPersonaPrefix: result.isPersonaPrefix
                }
            }
        }

        // 关键词触发
        if (groupCfg.keyword && cfg.keywords?.length > 0) {
            for (const kw of cfg.keywords) {
                if (kw && rawMsg.includes(kw)) {
                    return { triggered: true, msg: rawMsg }
                }
            }
        }

        // 随机触发
        if (groupCfg.random) {
            const rate = groupCfg.randomRate || 0.05
            if (Math.random() < rate) {
                return { triggered: true, msg: rawMsg }
            }
        }

        return { triggered: false }
    }

    /**
     * 带会话追踪的触发检查
     * 在显式触发后开始追踪，追踪期内通过AI判断是否继续对话
     */
    async checkTriggerWithTracking(cfg) {
        const e = this.e

        // 初始化会话追踪
        conversationTracker.init()

        // 先检查常规触发条件
        const baseResult = this.checkTrigger(cfg)

        // 如果常规触发成功
        if (baseResult.triggered) {
            // 群聊时开始会话追踪
            if (e.isGroup && e.group_id && e.user_id) {
                const groupId = String(e.group_id)
                const userId = String(e.user_id)

                if (conversationTracker.isEnabled()) {
                    conversationTracker.startTracking(groupId, userId)
                    logger.debug(`[Chat] 开始会话追踪: ${groupId}_${userId}`)
                }
            }
            return baseResult
        }

        // 常规触发失败，检查会话追踪
        if (!e.isGroup || !e.group_id || !e.user_id) {
            return { triggered: false }
        }

        if (!conversationTracker.isEnabled()) {
            return { triggered: false }
        }

        const groupId = String(e.group_id)
        const userId = String(e.user_id)

        // 检查是否在追踪期内
        if (!conversationTracker.isTracking(groupId, userId)) {
            return { triggered: false }
        }

        // 节流检查
        if (conversationTracker.isThrottled(groupId, userId)) {
            return { triggered: false }
        }

        // 更新节流时间
        conversationTracker.updateThrottle(groupId, userId)

        // 获取对话历史
        const activeConv = conversationTracker.getActiveConversation(groupId, userId)
        const chatHistory = activeConv?.chatHistory || []

        // 构建用户消息
        const senderName = e.sender?.card || e.sender?.nickname || '未知用户'
        const userMessage = `${senderName}: ${e.msg || ''}`

        // 使用批量判断队列（减少API调用）
        const isTalking = await conversationTracker.addToBatchJudgment(groupId, userId, userMessage, chatHistory, e)

        if (isTalking) {
            // 重置追踪定时器
            conversationTracker.startTracking(groupId, userId)
            logger.debug(`[Chat] 会话追踪判断为继续对话: ${groupId}_${userId}`)
            return { triggered: true, msg: e.msg || '' }
        }

        return { triggered: false }
    }

    /**
     * 检查前缀
     */
    checkPrefix(msg, prefixes = [], prefixPersonas = []) {
        // 前缀人格
        if (Array.isArray(prefixPersonas) && prefixPersonas.length > 0) {
            for (const persona of prefixPersonas) {
                if (!persona?.prefix) continue
                const prefix = persona.prefix.trim()
                if (msg.startsWith(prefix)) {
                    return {
                        matched: true,
                        prefix,
                        content: msg.slice(prefix.length).trimStart(),
                        persona: persona.preset || persona.systemPrompt,
                        isPersonaPrefix: true
                    }
                }
            }
        }
        // 普通前缀
        if (!Array.isArray(prefixes)) prefixes = [prefixes]
        prefixes = prefixes.filter(p => p && typeof p === 'string' && p.trim()).map(p => p.trim())
        for (const prefix of prefixes) {
            if (msg.startsWith(prefix)) {
                return { matched: true, prefix, content: msg.slice(prefix.length).trimStart(), isPersonaPrefix: false }
            }
        }
        return { matched: false }
    }

    /**
     * 清理@机器人（保留其他@）
     * 支持多种格式：CQ码、纯文本@botId、@机器人昵称
     */
    cleanAtBot(text) {
        if (!text) return ''
        const e = this.e
        const botId = e.self_id || e.bot?.uin || e.bot?.self_id || globalThis.Bot?.uin
        if (!botId) return text

        let result = text
        const botIdText = String(botId)

        // 1. 清理CQ码格式: [CQ:at,qq=botId] 或 [CQ:at,qq=botId,text=xxx]
        result = result.replace(new RegExp(`\\[CQ:at,qq=${botIdText}[^\\]]*\\]`, 'gi'), '')

        // 2. 清理纯文本@botId格式（注意保留后续内容）
        // 使用前瞻确保不会误删其他@：只删除@botId后面跟着空白或结尾的情况
        result = result.replace(new RegExp(`@${botIdText}(?=\\s|$|@)`, 'g'), '')

        // 3. 清理@机器人昵称（如果有）
        const botNickname = e.bot?.nickname
        if (botNickname) {
            const escapedNickname = botNickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            result = result.replace(new RegExp(`@${escapedNickname}(?=\\s|$|@)`, 'gi'), '')
        }

        // 4. 清理 Discord 风格 <@!botId>（QQBot 部分事件会带此格式）
        result = result.replace(new RegExp(`<@!?${botIdText}>`, 'g'), '')

        // 5. 清理多余空格，保留单个空格分隔
        result = result.replace(/\s+/g, ' ').trim()

        return result
    }

    /**
     * 收集群消息
     */
    collectGroupMessage(e) {
        if (!e.isGroup || !e.group_id) return
        try {
            memoryManager.collectGroupMessage(String(e.group_id), {
                user_id: e.user_id,
                sender: e.sender,
                msg: e.msg,
                raw_message: e.raw_message
            })
        } catch (err) {
            logger.debug('[Chat] 收集群消息失败:', err.message)
        }
    }

    /**
     * 处理聊天
     */
    async processChat(msg, options = {}) {
        const e = this.e
        const { persona, isPersonaPrefix } = options

        // 检测 debug 模式
        let debugMode = isDebugEnabled(e)
        let msgForChat = msg
        if (msgForChat && /\s+debug\s*$/i.test(msgForChat)) {
            debugMode = true
            msgForChat = msgForChat.replace(/\s+debug\s*$/i, '').trim()
        }

        const debugLogs = []

        // 解析消息
        const featuresConfig = config.get('features') || {}
        const parsedMessage = await parseUserMessage(e, {
            handleReplyText: featuresConfig.replyQuote?.handleText ?? true,
            handleReplyImage: featuresConfig.replyQuote?.handleImage ?? true,
            handleReplyFile: featuresConfig.replyQuote?.handleFile ?? true,
            handleForward: featuresConfig.replyQuote?.handleForward ?? true,
            handleAtMsg: true,
            excludeAtBot: true,
            includeSenderInfo: true,
            includeDebugInfo: debugMode
        })

        const rawTextContent = parsedMessage.content?.find(c => c.type === 'text')?.text?.trim()
        let textContent = msgForChat?.trim() || rawTextContent
        // 触发词取的是 e.msg，会丢掉 @ 提及；把解析出的提及信息补回去，否则 AI 看不到被 @ 的人
        if (textContent && rawTextContent) {
            const atTags = rawTextContent.match(/\[提及用户[^\]]*\]/g) || []
            const missing = atTags.filter(t => !textContent.includes(t))
            if (missing.length > 0) textContent = `${textContent} ${missing.join(' ')}`.trim()
        }

        if (!textContent && (!parsedMessage.content || parsedMessage.content.length === 0)) {
            return false
        }

        // 记录统计
        try {
            const msgTypes = parsedMessage.content?.map(c => c.type) || ['text']
            for (const type of msgTypes) {
                statsService.recordMessage({
                    type,
                    groupId: e.group_id?.toString() || null,
                    userId: e.user_id?.toString(),
                    source: e.adapter || 'unknown'
                })
            }
        } catch (err) {
            logger.debug('[Chat] 缓存消息统计失败:', err.message)
        }

        // 设置工具上下文
        setToolContext({ event: e, bot: e.bot || globalThis.Bot })
        mcpManager.setToolContext({ event: e, bot: e.bot || globalThis.Bot })

        // 处理图片
        const images = parsedMessage.content?.filter(c => c.type === 'image' || c.type === 'image_url') || []

        // 处理引用消息
        let finalMessage = textContent
        if (parsedMessage.quote) {
            const quoteSender = parsedMessage.quote.sender?.card || parsedMessage.quote.sender?.nickname || '某人'
            const quoteText =
                typeof parsedMessage.quote.content === 'string'
                    ? parsedMessage.quote.content
                    : parsedMessage.quote.raw_message || ''
            if (quoteText) {
                finalMessage = `[引用 ${quoteSender} 的消息: "${quoteText}"]\n${textContent}`
            }
        }

        const userId = e.user_id?.toString()
        const groupId = e.group_id?.toString() || null
        const conversationId = groupId ? `group:${groupId}` : contextManager.getConversationId(userId, null)
        const requestStartedAt = Date.now()
        const isRequestObsolete = () => {
            const state = presetManager.clearedContexts?.get(conversationId)
            return !!state && state.clearedAt >= requestStartedAt
        }

        // 构建请求
        const chatOptions = {
            userId,
            groupId,
            message: finalMessage,
            images,
            event: e,
            mode: 'chat',
            parsedMessage,
            debugMode
        }

        if (isPersonaPrefix && persona) {
            chatOptions.prefixPersona = persona
        }

        try {
            // 显示思考提示
            if (config.get('basic.showThinkingMessage') !== false) {
                await this.reply('思考中...', true)
            }

            const result = await chatService.sendMessage(chatOptions)
            if (isRequestObsolete()) {
                return true
            }

            // 处理回复
            if (result.response && result.response.length > 0) {
                await this.warmMemberMap()
                const replyContent = this.formatReply(result.response)
                if (replyContent) {
                    const replyTextContent = result.response
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join('\n')
                    if (replyTextContent) {
                        recordSentMessage(replyTextContent)

                        // 更新会话追踪历史
                        if (e.isGroup && e.group_id && e.user_id && conversationTracker.isEnabled()) {
                            const gid = String(e.group_id)
                            const uid = String(e.user_id)
                            if (conversationTracker.isTracking(gid, uid)) {
                                // 记录用户消息和机器人回复
                                conversationTracker.addToHistory(gid, uid, 'user', finalMessage)
                                conversationTracker.addToHistory(gid, uid, 'bot', replyTextContent)
                            }
                        }
                    }

                    const quoteReply = config.get('basic.quoteReply') === true
                    const longTextCfg = config.get('output.longText') || {}
                    const mathRenderEnabled = config.get('render.mathFormula') !== false

                    let handled = false

                    // 回复里要 @ 人时先确保群成员表可用，否则 @名字 无法转成真实 at
                    if (replyTextContent && String(replyTextContent).includes('@') && e.isGroup) {
                        try {
                            const existing = this.memberMapOf()
                            if (!(existing instanceof Map) || existing.size === 0) {
                                await e.group?.getMemberMap?.()
                            }
                        } catch (err) {
                            logger.debug('[Chat] 预热成员表失败:', err.message)
                        }
                    }

                    // 检测数学公式并渲染
                    if (mathRenderEnabled && replyTextContent) {
                        const mathDetection = renderService.detectMathFormulas(replyTextContent)
                        if (mathDetection.hasMath && mathDetection.confidence !== 'low') {
                            try {
                                const imageBuffer = await renderService.renderMathContent(replyTextContent, {
                                    theme: config.get('render.theme') || 'light',
                                    width: config.get('render.width') || 800
                                })
                                const replyResult = await this.reply(segment.image(imageBuffer), quoteReply)
                                this.handleAutoRecall(replyResult, false)
                                handled = true
                            } catch (err) {
                                logger.debug('[Chat] 长文本转图失败:', err.message)
                            }
                        }
                    }

                    // 文本统一发送：短回复单条、中等长度按语义分段逐条、超长折叠
                    if (!handled && replyTextContent) {
                        const toolWrapperFiltered = this.formatReplyTextOnly(result.response)
                        const toolWrapperNoise =
                            toolWrapperFiltered !== null &&
                            (this.isLikelyToolWrapperText(toolWrapperFiltered) ||
                                this.hasToolLikeSegment(toolWrapperFiltered))
                        const sentenceOutputCfg = config.get('output.sentenceOutput') || {}
                        // 单条可直发的文本长度上限：超过即进入语义分段/折叠流程
                        const DIRECT_SEND_LIMIT = 140
                        const useSegmentedOutput = sentenceOutputCfg.enabled && sentenceOutputCfg.chatEnabled !== false

                        // 拟人逐行发送：按换行拆成多条消息，顺带把 @名字/@QQ 转成真实 at
                        // 默认开启：逐行拆成多条发送（面板保存配置时可能把自定义键丢掉，所以用「不等于 false」判断）
                        if (!toolWrapperNoise && sentenceOutputCfg.lineSplit !== false) {
                            const lines = replyTextContent.split(/\n+/).map(t => t.trim()).filter(Boolean)
                            // 单轮最多 8 条、单条 ≤500 字；超出的合到最后一条，超长行交给折叠逻辑
                            const maxSegments = Math.max(1, Math.min(12, Number(sentenceOutputCfg.maxSegments) || 8))
                            const MAX_SEGMENT_CHARS = 500
                            if (lines.length > 1 && lines.every(l => l.length <= MAX_SEGMENT_CHARS)) {
                                if (lines.length > maxSegments) {
                                    const tail = lines.slice(maxSegments - 1).join(' ').slice(0, MAX_SEGMENT_CHARS)
                                    lines.splice(maxSegments - 1, lines.length, tail)
                                }
                                for (let i = 0; i < lines.length; i++) {
                                    const parts = this.processAtMentions(lines[i])
                                    const payload = parts.length > 1 ? parts : lines[i]
                                    const replyResult = await this.reply(payload, quoteReply && i === 0)
                                    if (i === 0) this.handleAutoRecall(replyResult, false)
                                    if (i < lines.length - 1) {
                                        const minD = Number(sentenceOutputCfg.minDelay) || 260
                                        const maxD = Math.max(minD + 100, Number(sentenceOutputCfg.maxDelay) || 900)
                                        const delay = minD + Math.floor(Math.random() * (maxD - minD))
                                        await new Promise(r => setTimeout(r, delay))
                                    }
                                }
                                handled = true
                            }
                        }
                        // 超长折叠阈值：超过则将整段回复折叠为合并转发/图片卡片
                        const foldLimit = Math.max(longTextCfg.threshold || 500, 500)
                        // 短回复临界值：可逐句发送的最大长度
                        const shortLimit = Math.max(DIRECT_SEND_LIMIT, foldLimit)

                        // 优先走统一分段发送（启用按句输出时对所有文本生效，否则仅长文本前置）
                        if (!handled && !toolWrapperNoise && (useSegmentedOutput || replyTextContent.length > DIRECT_SEND_LIMIT)) {
                            const sent = await sendSegmentedMessage(this, replyTextContent, {
                                quote: quoteReply,
                                decorate: text => this.processAtMentions(text),
                                shortLimit,
                                foldLimit,
                                foldHandler: async fullText => {
                                    if (longTextCfg.enabled === false) return false
                                    const mode = longTextCfg.mode || 'forward'
                                    if (mode === 'image') {
                                        try {
                                            const { renderService } =
                                                await import('../src/services/media/RenderService.js')
                                            const imageBuffer = await renderService.renderMarkdownToImage({
                                                markdown: fullText,
                                                title: 'AI 回复',
                                                icon: '💬',
                                                theme: config.get('render.theme') || 'light',
                                                width: config.get('render.width') || 800
                                            })
                                            const replyResult = await this.reply(segment.image(imageBuffer), quoteReply)
                                            this.handleAutoRecall(replyResult, false)
                                            return true
                                        } catch {
                                            return false
                                        }
                                    }
                                    if (mode === 'forward' || mode === 'auto') {
                                        try {
                                            // 转发卡片内的段落改为按语义切片，替换原先只按空行拆分的硬规则
                                            const paragraphs = splitMessageNatural(fullText, {
                                                chunkSize: 300,
                                                maxChunk: 500,
                                                mergeThreshold: 24
                                            })
                                            if (paragraphs.length > 0) {
                                                await this.sendForwardMsg(
                                                    longTextCfg.forwardTitle || 'AI 回复',
                                                    paragraphs
                                                )
                                                return true
                                            }
                                        } catch {
                                            /* 转发失败回退逐条 */
                                        }
                                    }
                                    return false
                                },
                                onSegmentSent(index, total, messageId) {
                                    if (index === 0 && messageId) {
                                        this.handleAutoRecall({ message_id: messageId }, false)
                                    }
                                }
                            })
                            if (sent.folded || sent.messageIds.length > 0) {
                                handled = true
                            }
                        }
                    }

                    // 默认直接输出（分段发送未接管时的兜底）
                    if (!handled) {
                        const pureText = this.formatReplyTextOnly(result.response) ?? ''
                        const isToolNoise =
                            pureText.length > 0 &&
                            (this.isLikelyToolWrapperText(pureText) || this.hasToolLikeSegment(pureText))
                        if (isToolNoise) {
                            // 整段都是工具调用残段，不当作最终回复发出
                            logger.debug('[Chat] 已抑制工具调用残段输出')
                        } else {
                            const replyResult = await this.reply(replyContent, quoteReply)
                            this.handleAutoRecall(replyResult, false)
                        }
                    }

                    // 表情包小偷
                    if (e.isGroup && e.group_id) {
                        try {
                            const emojiMsg = await emojiThiefService.tryTrigger(e, 'chat')
                            if (emojiMsg) {
                                await new Promise(r => setTimeout(r, Math.random() * 1000 + 300))
                                await this.reply(emojiMsg)
                            }
                        } catch (err) {
                            logger.debug('[Chat] 发送表情包失败:', err.message)
                        }
                    }
                }
            }

            // 发送调试信息
            if (debugMode && result.debugInfo) {
                this.sendDebugInfo(result.debugInfo, debugLogs)
            }
        } catch (error) {
            if (debugMode) {
                debugLogs.push({
                    title: '❌ 错误信息',
                    content: `${error.message || error}\n${error.stack || ''}`
                })
                this.sendDebugInfo({}, debugLogs)
            }

            const notified = await errorNotifier.notify(error, {
                e: this.e,
                userId: this.e?.user_id,
                groupId: this.e?.group_id,
                model: config.get('llm.defaultModel')
            })
            if (!notified) {
                logger.debug('[Chat] 请求失败且未启用错误通知，错误详情见上方日志:', error.message)
            }
        }

        return true
    }

    /**
     * 兼容入口：统一走 messageSegment 的语义分段实现。
     * 仅保留方法签名，避免历史调用点失效。
     * @param {string} text - 待拆分文本
     * @returns {string[]} 句子数组
     */
    splitIntoSentences(text) {
        return splitIntoSentencesNatural(text)
    }

    formatReply(response) {
        if (!response || !Array.isArray(response)) return null
        const messages = []
        for (const item of response) {
            switch (item.type) {
                case 'text':
                    if (item.text?.trim()) {
                        // 处理 @+数字 模式，转换为真实at
                        const processedParts = this.processAtMentions(item.text)
                        messages.push(...processedParts)
                    }
                    break
                case 'image':
                case 'image_url':
                    const url = item.url || item.image_url?.url
                    if (url) messages.push(segment.image(url))
                    break
                case 'audio':
                case 'record':
                    let audioData = item.url || item.data || item.file
                    if (audioData) {
                        if (
                            !audioData.startsWith('base64://') &&
                            !audioData.startsWith('http') &&
                            !audioData.startsWith('file://')
                        ) {
                            audioData = audioData.replace(/^data:audio\/[^;]+;base64,/, '')
                            audioData = `base64://${audioData}`
                        }
                        messages.push(segment.record(audioData))
                    }
                    break
            }
        }
        return messages.length > 0 ? messages : null
    }

    /**
     * 提取 response 中的纯文本内容（供工具残段检测复用）
     * @param {Array} response - 模型回复（content 数组）
     * @returns {string|null} 文本或 null
     */
    formatReplyTextOnly(response) {
        if (!Array.isArray(response)) return null
        const text = response
            .filter(c => c?.type === 'text')
            .map(c => c.text || '')
            .join('\n')
            .trim()
        return text || null
    }

    /**
     * 处理文本中的 @+数字 或 @+名字 模式，转换为真实at
     * @param {string} text - 原始文本
     * @returns {Array} 处理后的消息片段数组
     */
    processAtMentions(text) {
        const e = this.e
        if (!e?.isGroup || !e?.group_id) return [text]

        // 全角 ＠ 先归一化，模型偶尔会输出中文输入法下的全角符号
        let str = String(text).replace(/＠/g, '@')

        // 收集群成员：群名片/昵称 -> QQ
        const memberMap = this.memberMapOf()
        const byName = new Map()
        if (memberMap instanceof Map) {
            for (const [uid, member] of memberMap) {
                const id = Number(member?.user_id || uid)
                if (!Number.isFinite(id)) continue
                for (const raw of [member?.card, member?.nickname, member?.nick]) {
                    const name = String(raw || '').trim()
                    if (name && !byName.has(name)) byName.set(name, id)
                }
            }
        }

        // 用占位符标记要换成 at 的位置，最后再统一拆段
        const MARK = '\u0001'
        const END = '\u0002'

        // @QQ号
        str = str.replace(/@用户[（(]?(\d{5,12})[)）]?/g, (m, qq) => MARK + qq + END)
        str = str.replace(/@(\d{5,12})/g, (m, qq) => MARK + qq + END)

        // @群名片/昵称（长名字优先，避免「小明」把「小明同学」切坏）
        if (byName.size > 0) {
            const names = [...byName.keys()].filter(n => n.length >= 2).sort((a, b) => b.length - a.length)
            for (const name of names) {
                const token = '@' + name
                if (!str.includes(token)) continue
                str = str.split(token).join(MARK + byName.get(name) + END)
            }
        }

        // 模糊一轮：模型写的名字和群名片不完全一致时再兜一次
        if (byName.size > 0) {
            const names = [...byName.keys()].filter(n => n.length >= 2).sort((a, b) => b.length - a.length)
            str = str.replace(/@([^\s@，。！？,.!?~]{1,20})/g, (raw, word) => {
                if (raw.includes(MARK)) return raw
                const w = String(word || '').trim()
                if (w.length < 2) return raw
                const hit = names.find(n => n === w || n.startsWith(w) || w.startsWith(n)) ||
                    names.find(n => n.includes(w) || w.includes(n))
                return hit ? MARK + byName.get(hit) + END : raw
            })
        }

        // 拆回消息段
        const parts = []
        const re = new RegExp(MARK + '(\\d+)' + END, 'g')
        let last = 0
        let m
        while ((m = re.exec(str)) !== null) {
            if (m.index > last) parts.push(str.slice(last, m.index))
            parts.push(segment.at(Number(m[1])))
            last = m.index + m[0].length
        }
        if (last < str.length) parts.push(str.slice(last))

        const cleaned = parts.filter(p => typeof p !== 'string' || p.trim())
        const ats = cleaned.filter(p => p && p.type === 'at').map(p => p.qq)
        if (ats.length > 0) logger.mark(`[Chat] @转换成功: ${ats.join(',')} | 原文: ${String(text).slice(0, 80)}`)
        else if (String(text).includes('@')) logger.mark(`[Chat] @未转换: ${String(text).slice(0, 80)}`)
        return cleaned.length > 0 ? cleaned : [text]
    }

    /**
     * 在群内查找成员（通过QQ号）
     * @param {number} userId - 用户QQ号
     * @returns {Object|null} 成员信息
     */
    /** 成员缓存：适配器放在 bot.gml（Map<群号, Map<QQ, 成员>>），群对象本身没有 gml */
    memberMapOf() {
        const e = this.e
        if (!e) return null
        const gid = String(e.group_id)
        const bot = e.bot || globalThis.Bot
        let map = null
        try {
            map = bot?.gml?.get?.(gid) ?? bot?.gml?.get?.(Number(gid)) ?? null
        } catch (err) {
            logger.debug('[Chat] 读取群成员缓存失败:', err.message)
        }
        if (map instanceof Map) return map
        const g = e.group || bot?.pickGroup?.(gid)
        if (g?.gml instanceof Map) return g.gml
        if (g?._memberMap instanceof Map) return g._memberMap
        return null
    }

    /** 拉一次完整群成员列表填进缓存，@名字 才能转成真实 at */
    async warmMemberMap() {
        const e = this.e
        if (!e?.isGroup || !e?.group_id) return
        const gid = String(e.group_id)
        // gml 里可能只有最近说过话的人，不能因为 size>0 就跳过
        if (chatWarmedGroups.has(gid)) return
        try {
            const bot = e.bot || globalThis.Bot
            const g = e.group?.getMemberMap ? e.group : bot?.pickGroup?.(gid)
            if (typeof g?.getMemberMap !== 'function') return
            await g.getMemberMap()
            chatWarmedGroups.add(gid)
            logger.mark(`[Chat] 已加载群成员表 ${gid}（${bot?.gml?.get?.(gid)?.size ?? bot?.gml?.get?.(Number(gid))?.size ?? '?'} 人）`)
        } catch (err) {
            logger.debug('[Chat] 拉取群成员失败:', err.message)
        }
    }

    findMemberInGroup(userId) {
        const memberMap = this.memberMapOf()
        if (!(memberMap instanceof Map)) return null
        return memberMap.get(Number(userId)) || memberMap.get(String(userId)) || null
    }

    findMemberByName(name) {
        if (!name) return null
        const memberMap = this.memberMapOf()
        if (!(memberMap instanceof Map)) return null
        const searchName = name.toLowerCase().trim()
        for (const [uid, member] of memberMap) {
            const card = String(member?.card || '').toLowerCase()
            const nickname = String(member?.nickname || member?.nick || '').toLowerCase()
            if (card === searchName || nickname === searchName) return { ...member, user_id: member.user_id || uid }
        }
        for (const [uid, member] of memberMap) {
            const card = String(member?.card || '').toLowerCase()
            const nickname = String(member?.nickname || member?.nick || '').toLowerCase()
            if ((card && card.includes(searchName)) || (nickname && nickname.includes(searchName))) {
                return { ...member, user_id: member.user_id || uid }
            }
        }
        return null
    }

    /**
     * 发送调试信息
     *
     * 将各子模块信息通过内层合并转发分组，再包进一个外层大合并转发（嵌套转发），
     * 单段超过上限时自动分片，避免被 NapCat/icqq 静默截断。
     */
    async sendDebugInfo(debugInfo, debugLogs) {
        const di = debugInfo
        const truncate = (value, max = 1800) => {
            const s = typeof value === 'string' ? value : JSON.stringify(value)
            if (!s) return ''
            return s.length > max ? `${s.substring(0, max)}...（已截断）` : s
        }
        const push = (title, value) => {
            if (value === undefined || value === null) return
            debugLogs.push({ title, content: truncate(value) })
        }

        push('📡 渠道信息', di.channel)
        // ChatService 写入的渠道字段是 id 而不是 channelId，原判定恒为假导致切换链永不输出
        if (di.channel?.id) push('🔀 渠道切换链', di.switchChain)
        if (di.channel) push('🔁 重试统计', di.retryStats)
        if (di.channel)
            push('🎯 实际模型/渠道', {
                usedModel: di.usedModel,
                usedChannel: di.usedChannel,
                fallbackUsed: di.fallbackUsed
            })
        push('🎭 预设信息', di.preset)
        push('🎯 Scope信息', di.scope)
        push('🧠 记忆信息', di.memory)
        push('📚 知识库信息', di.knowledge)
        // di.request 恒被初始化为 {}，只在模型/消息数有效时才输出
        if (di.request?.model || di.request?.messagesCount)
            debugLogs.push({
                title: '📤 请求信息',
                content: truncate({ model: di.request?.model, messagesCount: di.request?.messagesCount })
            })
        push('🛠️ 可用工具', di.availableTools)
        push('🔧 工具调用', di.toolCalls)
        push('📥 响应信息', di.response)
        // timing.duration 在 ChatService 正常路径恒缺失，用缺省文案代替 undefinedms
        if (di.timing?.duration !== undefined) {
            debugLogs.push({ title: '⏱️ 耗时', content: `${di.timing.duration}ms` })
        } else if (di.timing) {
            debugLogs.push({ title: '⏱️ 耗时', content: '未统计（响应阶段未写入 duration）' })
        }

        if (debugLogs.length > 0) {
            try {
                const { StandardMessage, StandardBotApi } = await import('../src/core/platform/index.js')
                const selfId = this.e.self_id || this.e.user_id || this.e.bot?.uin || 10000

                // 内层：每个 debug 分组作为一个子合并转发节点；
                // 单段超长时按 1800 字符分片为多个子节点
                const splitIntoChunks = (text, size = 1800) => {
                    const lines = String(text || '').split('\n')
                    const chunks = []
                    let current = ''
                    for (const line of lines) {
                        if ((current + '\n' + line).trim().length > size && current) {
                            chunks.push(current)
                            current = line
                        } else {
                            current = current ? `${current}\n${line}` : line
                        }
                    }
                    if (current) chunks.push(current)
                    return chunks.length ? chunks : ['']
                }

                const outerNodes = debugLogs.map(log => {
                    const chunks = splitIntoChunks(`【${log.title}】\n${log.content}`)
                    const childNodes = chunks.map(part => StandardMessage.nodeItem(selfId, log.title, part))
                    // 内层合并转发 = 一个 nestedForward 节点
                    return {
                        user_id: selfId,
                        nickname: log.title,
                        message: StandardMessage.nestedForward(log.title, childNodes)
                    }
                })

                // 组装好的完整节点数组必须直通 sendForward，不能再经过
                // platformAdapter.sendForwardMsg 的二次包装（会把嵌套 node 段压成畸形 JSON）
                const api = new StandardBotApi({ event: this.e, bot: this.e.bot || globalThis.Bot })
                await api.sendForward({
                    groupId: this.e.group_id,
                    userId: this.e.group_id ? null : this.e.user_id,
                    nodes: outerNodes
                })
            } catch (err) {
                logger.debug('[Chat] 发送合并转发失败:', err.message)
            }
        }
    }

    /**
     * 处理自动撤回
     */
    handleAutoRecall(replyResult, isError = false) {
        const autoRecall = config.get('basic.autoRecall')
        if (!autoRecall || autoRecall.enabled !== true) return
        if (isError && autoRecall.recallError !== true) return

        const delay = (autoRecall.delay || 60) * 1000
        const messageId = replyResult?.message_id || replyResult?.data?.message_id
        if (!messageId) return

        const e = this.e
        setTimeout(async () => {
            try {
                const currentConfig = config.get('basic.autoRecall')
                if (!currentConfig || currentConfig.enabled !== true) return
                const bot = e?.bot || globalThis.Bot
                if (typeof bot?.deleteMsg === 'function') {
                    await bot.deleteMsg(messageId)
                } else if (typeof bot?.recallMsg === 'function') {
                    await bot.recallMsg(messageId)
                }
            } catch (err) {
                logger.debug('[Chat] 撤回消息失败:', err.message)
            }
        }, delay)
    }

    /**
     * 格式化错误信息
     */
    formatErrorForUser(error) {
        const msg = error.message || String(error)
        if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('quota')) {
            const retryMatch = msg.match(/retry in ([\d.]+)s/i)
            const retryTime = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 60
            return `⚠️ API 请求过于频繁，请 ${retryTime} 秒后重试`
        }
        if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('API key')) {
            return '⚠️ API 认证失败，请检查 API Key 配置'
        }
        if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
            return '⚠️ 模型不存在或不可用，请检查模型配置'
        }
        if (msg.includes('insufficient') || msg.includes('balance') || msg.includes('billing')) {
            return '⚠️ API 余额不足，请检查账户'
        }
        if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
            return '⚠️ 请求超时，请稍后重试'
        }
        if (msg.includes('ENOTFOUND') || msg.includes('network') || msg.includes('fetch')) {
            return '⚠️ 网络连接失败，请检查网络'
        }
        if (msg.includes('content') && (msg.includes('filter') || msg.includes('block') || msg.includes('safety'))) {
            return '⚠️ 内容被安全过滤，请换个话题'
        }
        const shortMsg = msg.split('\n')[0].substring(0, 100)
        return `出错了: ${shortMsg}${msg.length > 100 ? '...' : ''}`
    }

    /**
     * 发送合并转发消息
     */
    async sendForwardMsg(title, messages) {
        return platformSendForwardMsg(this.e, title, messages)
    }

    /**
     * 判断文本是否像"被拆成段的工具调用包裹文本"。
     * 某些渠道（如 codex 类）的适配器会输出含 tool_call 标记的分段文本，
     * 展示层要抑制这类噪音，不产生"1. 2. 3."的残破消息。
     * @param {unknown} text - 输入文本
     * @returns {boolean} 是否应为工具文本包裹
     */
    isLikelyToolWrapperText(text) {
        const t = String(text ?? '').trim()
        if (!t || t.length > 120) return false
        if (/\n/.test(t)) return false
        return /^[\d.（(【[、:：\-—\s]*$/.test(t) || /^[a-z_]{2,}[（(]?[：:]?$/.test(t)
    }

    /**
     * 判断文本是否含工具调用结构化字段。
     * @param {unknown} text - 输入文本
     * @returns {boolean} 含 tool_call/function/arguments 等标记
     */
    hasToolLikeSegment(text) {
        return /\b(tool_call|function|arguments)\b/.test(String(text || ''))
    }
}
