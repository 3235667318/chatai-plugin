/**
 * @fileoverview 记忆管理模块
 * @module services/storage/MemoryManager
 * @description 管理AI的长期记忆，支持自动提取、存储和检索用户信息
 */

import { chatLogger } from '../../core/utils/logger.js'
const logger = chatLogger
import config from '../../../config/config.js'
import { databaseService } from './DatabaseService.js'
import { LlmService } from '../llm/LlmService.js'
import { delegateRequest } from '../llm/LlmDelegator.js'
import { statsService } from '../stats/StatsService.js'
import { resolveClientTemperature } from '../llm/TemperatureResolver.js'
import { formatUserMemoryBlock } from '../memory/MemoryService.js'

/** 时间戳 Map 的条目上限 */
const TIME_MAP_MAX_SIZE = 5000
/** 时间戳 Map 的条目最大存活时长(ms) */
const TIME_MAP_MAX_AGE = 7 * 24 * 60 * 60 * 1000
/** 轮询游标在 kv_store 中的键前缀，进程重启后据此恢复上次处理时间 */
const POLL_KV_PREFIX = 'memory:poll:last:'

/**
 * 构建群聊记忆提取提示词。
 *
 * 定时增量分析（analyzeGroupContext）与按时间范围手动总结（summarizeGroupMemoryByTimeRange）
 * 原本各写一份几乎相同的提示词，仅条数上限不同，措辞漂移会让两条路径产出不同风格的记忆。
 *
 * 输出格式与 analyzeGroupContext / summarizeGroupMemoryByTimeRange 中的
 * `/【用户[:：](.+?)】(.+)/`、`/【话题】(.+)/`、`/【关系】(.+)/` 三个正则严格耦合，禁止改动括号与标签文字。
 *
 * @param {Object} options - 构建选项
 * @param {string} options.dialogText - 群聊记录文本，每行形如 `[昵称]: 内容`
 * @param {string} options.existingMemoryText - 现有记忆文本，无则传空串
 * @param {number} options.maxItems - 输出条数上限
 * @param {string} [options.scopeHint] - 记录范围描述，如“过去30分钟内的120条消息”
 * @param {string} [options.analysisTypes] - 分析维度描述，缺省为“用户特征、话题、关系”
 * @returns {string} 完整提示词
 */
/**
 * 构建群聊记忆的 system / user 两段提示词。
 *
 * system 只放固定指令与输出格式，跨群、跨轮次完全一致，便于命中上下文缓存；
 * user 放本次的记录范围、分析维度、条数上限、现有记忆与群聊记录。
 *
 * 输出格式与 analyzeGroupContext / summarizeGroupMemoryByTimeRange 中的
 * 【用户:昵称】【话题】【关系】解析正则严格耦合，禁止改动括号与标签文字。
 *
 * @param {Object} options - 构建选项
 * @param {string} options.dialogText - 群聊记录文本，每行形如 `[昵称]: 内容`
 * @param {string} options.existingMemoryText - 现有记忆文本，无则传空串
 * @param {number} options.maxItems - 输出条数上限
 * @param {string} [options.scopeHint] - 记录范围描述，如“过去30分钟内的120条消息”
 * @param {string} [options.analysisTypes] - 分析维度描述，缺省为“用户特征、话题、关系”
 * @returns {{system: string, user: string}} 两段提示词
 */
function buildGroupMemoryPrompts(options = {}) {
    const {
        dialogText,
        existingMemoryText,
        maxItems,
        scopeHint = '以下群聊记录',
        analysisTypes = '用户特征、话题、关系'
    } = options

    const system = `你是群聊记忆管理专家。分析用户消息中给出的【群聊记录】，提取值得长期保留的信息。

【重要规则】
- 每条消息格式为 [昵称(QQ号)]: 内容，方括号里是该用户的群名片和 QQ
- 只记录用户自己说出口的具体信息，不要从语气、话题或他人发言推测
- 按 昵称(QQ号) 区分用户，同名不同 QQ 视为两个人
- 忽略无实质内容的日常对话（如“哈哈”“好的”“在吗”）
- 不记录：游戏进度/数值/装备/关卡、指令用法、余额/用量统计、文件分享、抽奖签到、刷屏内容
- 只记录群层面的长期信息：群规则、固定活动、长期项目、约定、群梗和黑话、成员关系
- 【话题】必须是能长期复用的主题（例如“每周五晚群内开黑”），不能是某一次游戏战况
- 称谓/辈分必须逐字来自对话原话：师祖 ≠ 师姐 ≠ 师尊，不得替换、推测或按印象改写
- 每条关系必须写清“谁对谁”，例如“A叫B‘师祖’”；不确定是谁说的就不记
- 没有任何长期信息时，只输出一个“无”，不要硬凑

【总结要求】
1. 把用户消息里的【现有记忆】与新记录合并成一份完整记忆，删除重复、过时或已被推翻的条目
2. 用户信息必须写明是谁，例如“小明喜欢打游戏”，不能写“有人喜欢打游戏”
3. 话题必须是具体主题，例如“讨论原神3.0版本”，不能写“聊游戏”
4. 关系必须写明双方，例如“小明和小红是好友”；称呼类关系必须写清方向，例如“虚心叫清华得不到的学生‘糖糖姐姐’”，不要写反
5. 不要输出分析过程、小标题或编号，只输出结果行

【输出格式（严格 JSON）】
只输出一个 JSON 对象，不要 markdown 代码块、不要解释、不要多余文字：
{"memories":[{"type":"user","name":"群名片(QQ号)","content":"该用户的具体信息"},{"type":"topic","content":"长期话题"},{"type":"relation","content":"A和B：关系描述"}]}
条数上限以用户消息中的【条数上限】为准；没有任何值得记录的信息时输出：{"memories":[]}`

    const user = `【记录范围】${scopeHint}
【分析维度】${analysisTypes}
【条数上限】${maxItems}
【现有记忆】
${existingMemoryText || '暂无'}
【群聊记录】
${dialogText}`

    return { system, user }
}

/**
 * 兼容旧调用：把 system / user 拼成单条字符串。
 * 新链路请直接用 buildGroupMemoryPrompts，让固定指令走 system 以命中缓存。
 */
/** 临时/游戏进度类记忆特征：只保留长期稳定信息 */
const TRANSIENT_MEMORY_RE =
    /(提到|要求|在群内|进度|选择|境界|锁妖|开箱|箱子|第\s*\d+\s*层|\d+\s*号箱|挂机|挂自动|自动出招|答题|上香|重启|好感|饱食|水质|配饰|血量|蓝量|战力|签到|抽卡|刷到|打了|开了|败了|搞不起)/

/** 内容里写了别人的 QQ（与本用户不一致）时丢弃，避免记错人 */
function mentionsOtherQQ(content, userId) {
    const m = String(content || '').match(/QQ(?:号|为|是)?\s*[:：]?\s*(\d{5,12})/)
    if (!m) return false
    const clean = String(userId || '').replace(/\.0+$/, '')
    return m[1] !== clean
}

function isTransientMemory(content) {
    return TRANSIENT_MEMORY_RE.test(String(content || ''))
}

function buildGroupMemoryPrompt(options = {}) {
    const { system, user } = buildGroupMemoryPrompts(options)
    return `${system}\n\n${user}`
}


/**
 * @class MemoryManager
 * @classdesc 记忆管理器 - 使用数据库存储和管理AI的长期记忆
 *
 * @description
 * @example
 * // 获取用户记忆
 * const memories = await memoryManager.getMemories(userId)
 *
 * // 添加记忆
 * await memoryManager.addMemory(userId, '喜欢编程', 'preference')
 *
 * // 搜索记忆
 * const results = await memoryManager.searchMemories('编程', { userId })
 */
export class MemoryManager {
    constructor() {
        this.initialized = false
        this.pollInterval = null
        this.lastPollTime = new Map() // userId -> timestamp
        this.lastSummarizeTime = new Map() // groupId/userId -> timestamp 记录上次总结时间
    }

    /**
     * 获取单目标的查询游标。
     *
     * 先取内存 Map 快路径，落在本轮进程内即改用内存值；重启后内存记录丢失，
     * 再用 kv_store 持久化游标兜底。碰撞窗口方案（写入 `处理前时间点`）保证重启后
     * 同一批对话会被重新处理一遍，且所有关于 minPollInterval 的最新信息仍由
     * pollAndSummarize 限于 KV 值所在轮次之内。
     *
     * @param {string} pollKey - 目标标识（私聊为用户，群聊为 `group:<gid>:user:<uid>`）
     * @returns {{memoryTs: number, kvTs: number, effectiveTs: number}} 游标三元组
     */
    _resolvePollCursor(pollKey) {
        const memoryTs = this.lastPollTime.get(pollKey) || 0
        let kvTs = 0
        try {
            const raw = databaseService.getKV(`${POLL_KV_PREFIX}${pollKey}`)
            if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) kvTs = raw
        } catch (err) {
            logger.debug('[MemoryManager] 读取轮询 KV 游标失败，回退内存值:', err.message)
        }
        return { memoryTs, kvTs, effectiveTs: Math.max(memoryTs, kvTs) }
    }

    /**
     * 限制时间戳 Map 的规模：先清理过期条目，仍超限则淘汰最旧的
     * 这两个 Map 按 userId / groupId 累积且原先永不删除
     * @param {Map<string, number>} map - 键到时间戳的映射
     * @returns {void}
     */
    _capTimeMap(map) {
        if (!map || map.size <= TIME_MAP_MAX_SIZE) return

        const now = Date.now()
        for (const [key, ts] of map) {
            if (now - ts > TIME_MAP_MAX_AGE) map.delete(key)
        }

        if (map.size <= TIME_MAP_MAX_SIZE) return
        const sorted = [...map.entries()].sort((a, b) => a[1] - b[1])
        for (const [key] of sorted.slice(0, map.size - TIME_MAP_MAX_SIZE)) {
            map.delete(key)
        }
    }

    /**
     * Initialize memory manager
     */
    async init() {
        if (this.initialized) return
        databaseService.init()
        this.initialized = true

        // 启动周期性轮询
        this.startPolling()
        logger.debug('[MemoryManager] Initialized')
    }

    /**
     * 启动周期性轮询
     */
    startPolling() {
        if (!config.get('memory.enabled')) return

        const intervalMinutes = config.get('memory.pollInterval') || 5
        const intervalMs = intervalMinutes * 60 * 1000

        // 清除旧的定时器
        if (this.pollInterval) {
            clearInterval(this.pollInterval)
        }

        // 启动新的定时器
        this.pollInterval = setInterval(() => {
            this.pollAndSummarize().catch(e => logger.warn('[MemoryManager] 轮询分析失败:', e.message))
        }, intervalMs)

        logger.debug(`[MemoryManager] 启动周期轮询: ${intervalMinutes}分钟`)

        // 启动群聊上下文采集
        this.startGroupContextCollection()
    }

    /**
     * 启动群聊上下文采集
     */
    startGroupContextCollection() {
        const groupConfig = config.get('memory.groupContext') || {}
        if (!groupConfig.enabled) return

        const intervalMinutes = groupConfig.collectInterval || 10
        const intervalMs = intervalMinutes * 60 * 1000

        // 清除旧的定时器
        if (this.groupContextInterval) {
            clearInterval(this.groupContextInterval)
        }

        // 启动新的定时器
        this.groupContextInterval = setInterval(() => {
            this.collectAndAnalyzeGroupContext().catch(e =>
                logger.warn('[MemoryManager] 群聊上下文分析失败:', e.message)
            )
        }, intervalMs)

        logger.debug(`[MemoryManager] 启动群聊上下文采集: ${intervalMinutes}分钟`)
    }

    /**
     * 采集并分析群聊上下文
     */
    async collectAndAnalyzeGroupContext() {
        const groupConfig = config.get('memory.groupContext') || {}
        if (!groupConfig.enabled) return

        try {
            // 获取所有活跃群聊
            const groupMessages = this.groupMessageBuffer || new Map()

            for (const [groupId, messages] of groupMessages) {
                const threshold = groupConfig.analyzeThreshold || 20
                if (messages.length < threshold) continue

                // 分析群聊上下文
                await this.analyzeGroupContext(groupId, messages)

                // 清空已分析的消息
                groupMessages.delete(groupId)
            }
        } catch (error) {
            logger.warn('[MemoryManager] 群聊上下文分析失败:', error.message)
        }
    }

    /**
     * 收集群聊消息（由监听器调用）
     * @param {string} groupId - 群ID
     * @param {Object} message - 消息对象
     */
    collectGroupMessage(groupId, message) {
        if (!this.groupMessageBuffer) {
            this.groupMessageBuffer = new Map()
        }

        if (!this.groupMessageBuffer.has(groupId)) {
            this.groupMessageBuffer.set(groupId, [])
        }

        const messages = this.groupMessageBuffer.get(groupId)
        const maxMessages = 100 // 内存保留100条

        const msgData = {
            userId: message.user_id,
            nickname: message.sender?.nickname || message.sender?.card || '未知',
            content: message.msg || message.raw_message || '',
            timestamp: Date.now()
        }

        // 添加到内存缓冲区
        messages.push(msgData)

        // 限制内存消息数量
        while (messages.length > maxMessages) {
            messages.shift()
        }

        // 同时持久化到数据库（用于群聊总结的保底数据）
        // groupContext 关闭后不再落库，避免无人使用的 group_summary_* 白占磁盘
        if (config.get('memory.groupContext.enabled') === false) return
        try {
            databaseService.init()
            const conversationId = `group_summary_${groupId}`
            databaseService.saveMessage(conversationId, {
                role: 'user',
                content: `[${msgData.nickname}]: ${msgData.content}`,
                timestamp: msgData.timestamp,
                metadata: { userId: msgData.userId, nickname: msgData.nickname }
            })
            // 保留最近100条
            databaseService.trimMessages(conversationId, 100)
        } catch (e) {
            // 静默失败，不影响主流程
        }
    }

    /**
     * 分析群聊上下文，提取记忆
     * @param {string} groupId - 群ID
     * @param {Array} messages - 消息列表
     */
    async analyzeGroupContext(groupId, messages) {
        const groupConfig = config.get('memory.groupContext') || {}

        let startTime = null
        let channelInfo = null
        let model = null

        try {
            // 构建对话文本
            const dialogText = messages
             .map(m => {
                 const qq = String(m.userId ?? m.user_id ?? m.sender?.user_id ?? '')
                 const name = m.nickname || m.sender?.card || m.sender?.nickname || qq || '未知'
                 return `[${name}${qq ? `(${qq})` : ''}]: ${String(m.content || '').substring(0, 100)}`
             })
             .join('\n')

            if (dialogText.length < 100) return
            const existingTopics = databaseService.getMemories(`group:${groupId}:topics`, 20)
            const existingRelations = databaseService.getMemories(`group:${groupId}:relations`, 20)
            const existingUserInfos = databaseService.getMemoriesByPrefix(`group:${groupId}:user:`, 30)

            const existingMemoryText = [
                existingTopics.length > 0 ? `话题: ${existingTopics.map(t => t.content).join('; ')}` : '',
                existingRelations.length > 0 ? `关系: ${existingRelations.map(r => r.content).join('; ')}` : '',
                existingUserInfos.length > 0 ? `用户信息: ${existingUserInfos.map(u => u.content).join('; ')}` : ''
            ]
                .filter(Boolean)
                .join('\n')
            const analysisTypes = []
            if (groupConfig.extractUserInfo) analysisTypes.push('用户特征和偏好')
            if (groupConfig.extractTopics) analysisTypes.push('讨论话题')
            if (groupConfig.extractRelations) analysisTypes.push('社交关系')

            // 覆盖式总结提示词：固定指令走 system 命中缓存，数据走 user
            const { system: groupMemorySystem, user: groupMemoryUser } = buildGroupMemoryPrompts({
                dialogText,
                existingMemoryText,
                maxItems: 15,
                analysisTypes: analysisTypes.join('、') || undefined
            })

            const startTime = Date.now()
            const memoryModel = config.get('memory.model')
            const client = await LlmService.getChatClient({ model: memoryModel || undefined })
            channelInfo = client._channelInfo || {}
            model = channelInfo.model || config.get('llm.defaultModel')
            const _temp = resolveClientTemperature(client, 0.3)
            const result = await this._sendMemoryLlm(
                client,
                { role: 'user', content: [{ type: 'text', text: groupMemoryUser }] },
                {
                    model,
                    maxToken: 600,
                    disableHistorySave: true,
                    systemOverride: groupMemorySystem,
                    ...(_temp !== undefined ? { temperature: _temp } : {})
                },
                'MemoryGroupContext'
            )

            const responseText = result.contents?.[0]?.text?.trim() || ''
            // 记录统计
            try {
                const recordSuccess = typeof responseText === 'string' && responseText.length > 0
                await statsService.recordApiCall({
                    channelId: channelInfo.id || 'memory',
                    channelName: channelInfo.name || '记忆服务',
                    model,
                    reportedModel: result.model || null,
                    duration: Date.now() - startTime,
                    success: recordSuccess,
                    source: '群记忆总结',
                    groupId,
                    responseText,
                    apiUsage: result.usage,
                    request: {
                        messages: [
                            { role: 'system', content: groupMemorySystem },
                            { role: 'user', content: groupMemoryUser }
                        ],
                        model
                    },
                    response: !recordSuccess ? { error: '响应为空' } : null
                })
            } catch (e) {
                /* 统计失败不影响主流程 */
            }

            if (!responseText || responseText === '无' || responseText.length < 10) return

            // 解析并覆盖保存记忆
            const jsonLines = this._jsonToMemoryLines(responseText)
            const lines = jsonLines || responseText.split('\n').filter(line => line.trim())

            // 收集新记忆
            const newTopics = []
            const newRelations = []
            const newUserInfos = new Map() // nickname -> info

            for (const line of lines) {
                // 过滤无效行
                if (this._isInvalidMemoryLine(line)) continue

                // 提取用户记忆（extractUserInfo 关闭时不保存）
                const userMatch = line.match(/【用户[:：](.+?)】(.+)/)
                if (userMatch) {
                    if (!groupConfig.extractUserInfo) continue
                    const nickname = userMatch[1].trim()
                    const info = userMatch[2].trim()
                    if (info.length > 3 && info.length < 100) {
                        // 同一用户可能有多条信息，合并
                        const existing = newUserInfos.get(nickname) || []
                        existing.push(info)
                        newUserInfos.set(nickname, existing)
                    }
                    continue
                }

                // 提取话题记忆（extractTopics 关闭时不保存，并过滤游戏/刷屏类话题）
                const topicMatch = line.match(/【话题】(.+)/)
                if (topicMatch) {
                    if (!groupConfig.extractTopics) continue
                    const topic = topicMatch[1].trim()
                    if (topic.length > 3 && topic.length < 100 && !isTransientMemory(topic)) {
                        if (!this._isJunkMemoryLine(topic)) newTopics.push(topic)
                    }
                    continue
                }

                // 提取关系记忆（extractRelations 关闭时不保存）
                const relationMatch = line.match(/【关系】(.+)/)
                if (relationMatch) {
                    if (!groupConfig.extractRelations) continue
                    const relation = relationMatch[1].trim()
                    if (relation.length > 3 && relation.length < 100) {
                        if (!this._isJunkMemoryLine(relation)) newRelations.push(relation)
                    }
                }
            }

            // 覆盖式替换群记忆（清空 + 写入在同一事务内，避免中途失败丢失旧记忆）
            if (newTopics.length > 0) {
                databaseService.replaceMemories(
                    `group:${groupId}:topics`,
                    newTopics.slice(0, 10).map(topic => ({ content: topic, source: 'group_context' }))
                )
            }

            if (newRelations.length > 0) {
                databaseService.replaceMemories(
                    `group:${groupId}:relations`,
                    newRelations.slice(0, 10).map(relation => ({ content: relation, source: 'group_context' }))
                )
            }

            if (newUserInfos.size > 0) {
                // 清除旧用户信息并保存新的
                for (const [nickname, infos] of newUserInfos) {
                    databaseService.replaceMemories(
                        `group:${groupId}:user:${nickname}`,
                        infos.slice(0, 3).map(info => ({ content: info, source: 'group_context' }))
                    )
                }
            }

            try {
                this._syncGroupMemoriesToStructured(groupId, newTopics, newRelations)
            } catch (err) {
                logger.debug('[MemoryManager] 同步群记忆到结构化失败:', err.message)
            }

            logger.debug(
                `[MemoryManager] 群 ${groupId} 覆盖式总结完成: 话题${newTopics.length} 关系${newRelations.length} 用户${newUserInfos.size}`
            )
        } catch (error) {
            logger.debug(`[MemoryManager] 分析群 ${groupId} 上下文失败:`, error.message)
            try {
                await statsService.recordApiCall({
                    channelId: channelInfo?.id || 'memory',
                    channelName: channelInfo?.name || '记忆服务',
                    model: model || config.get('llm.defaultModel'),
                    duration: startTime ? Date.now() - startTime : 0,
                    success: false,
                    error: error.message || String(error),
                    source: '群记忆总结',
                    groupId
                })
            } catch (e) {
                /* 统计失败不影响主流程 */
            }
        }
    }

    /**
     * 检查是否是无效的记忆行
     * @param {string} line
     * @returns {boolean}
     */
    /** 把群话题/关系同步到 structured_memories（group_id 维度，user_id 固定为 group） */
    /** 按聊天记录数量/日期范围手动总结群记忆 */
    async summarizeGroupFromHistory(groupId, options = {}) {
        const gid = String(groupId || '').trim()
        if (!gid) throw new Error('缺少群号')
        const count = Math.min(2000, Math.max(10, parseInt(options.count, 10) || 300))
        let bot = null
        try {
            const BotObj = globalThis.Bot
            const bots = BotObj?.bots && typeof BotObj.bots === 'object' ? Object.values(BotObj.bots) : []
            bot = bots.find(b => typeof b?.sendApi === 'function') || null
            if (!bot && typeof BotObj?.sendApi === 'function') bot = BotObj
        } catch {}
        if (!bot?.sendApi) throw new Error('OneBot 未连接，无法拉取群历史')

        const res = await bot.sendApi('get_group_msg_history', { group_id: gid, count })
        let msgs = res?.data?.messages || res?.messages || []
        if (!Array.isArray(msgs)) msgs = []

        const startTs = options.start ? new Date(options.start).getTime() / 1000 : 0
        const endTs = options.end ? new Date(options.end).getTime() / 1000 + 86400 : Infinity
        msgs = msgs.filter(m => {
            const t = Number(m.time || 0)
            return t >= startTs && t <= endTs
        })

        const lines = []
        for (const m of msgs) {
            const text = Array.isArray(m.message)
                ? m.message.filter(x => x.type === 'text').map(x => x.data?.text || '').join('')
                : String(m.raw_message || '')
            const t = text.replace(/\s+/g, ' ').trim()
            if (!t) continue
            const sender = m.sender || {}
            const name = sender.card || sender.nickname || String(m.user_id || '')
            const qq = String(m.user_id || sender.user_id || '')
            const stamp = new Date(Number(m.time || 0) * 1000).toLocaleString('zh-CN', {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            })
            lines.push(`[${stamp}] [${name}(${qq})]: ${t.slice(0, 150)}`)
        }
        if (!lines.length) throw new Error('所选范围内没有可总结的聊天记录')

        const system = '你是群聊记忆整理专家。根据群聊记录提炼群层面的长期记忆，只输出 JSON，不要解释。'
        const user =
            `下面是群 ${gid} 的 ${lines.length} 条聊天记录。\n\n` +
            '输出 JSON：\n' +
            '{"topics":["长期话题"],"relations":["A(QQ)和B(QQ)：关系描述"],"summary":"近期上下文总结，200字以内"}\n\n' +
            '要求：\n' +
            '- topics 最多 12 条，只写能长期复用的主题\n' +
            '- relations 最多 12 条，写清双方昵称和 QQ\n' +
            '- summary 200 字以内\n' +
            '- 没有的内容用空数组/空字符串\n' +
            '- 只输出 JSON\n\n聊天记录：\n' +
            lines.join('\n')

        const model = config.get('memory.model') || undefined
        const client = await LlmService.getChatClient({ model })
        const usedModel = client._channelInfo?.model || config.get('llm.defaultModel')
        const parseJson = text => {
            const t = String(text || '').trim()
            const matches = t.match(/\{[\s\S]*?\}/g)
            if (!matches) return {}
            for (let i = matches.length - 1; i >= 0; i--) {
                try {
                    const o = JSON.parse(matches[i])
                    if (o && (o.topics || o.relations || o.summary)) return o
                } catch {}
            }
            return {}
        }

        let raw = ''
        // 记忆总结走 Command Code 中转（要求 JSON 输出）
        const channels = config.get('channels') || []
        const relay = channels.find(c => String(c.baseUrl || '').includes('commandcode.ai')) ||
            channels.find(c => String(c.id || '') === 'openai-7e637d96')

        const callRelay = async () => {
            if (!relay?.apiKey || !relay?.baseUrl) throw new Error('未配置 Command Code 中转渠道')
            const url = String(relay.baseUrl).replace(/\/$/, '') + '/chat/completions'
            const header = {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${relay.apiKey}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
            }
            const makeBody = extraSystem =>
                JSON.stringify({
                    model: 'deepseek/deepseek-v4.1-flash',
                    messages: [
                        { role: 'system', content: system + (extraSystem ? ' ' + extraSystem : '') },
                        { role: 'user', content: user }
                    ],
                    temperature: 0.2,
                    max_tokens: 3000,
                    response_format: { type: 'json_object' }
                })

            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const ctrl = new AbortController()
                    const timer = setTimeout(() => ctrl.abort(), 120000)
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: header,
                        body: makeBody(attempt === 2 ? '只输出 JSON 对象，不要任何解释。' : ''),
                        signal: ctrl.signal
                    })
                    clearTimeout(timer)
                    const rawText = await resp.text().catch(() => '')
                    if (!resp.ok) {
                        logger.debug(`[MemoryManager] 中转 HTTP ${resp.status}: ${rawText.slice(0, 120)}`)
                        continue
                    }
                    const data = JSON.parse(rawText || '{}')
                    const out = String(data?.choices?.[0]?.message?.content || '')
                    if (out.trim()) return out
                } catch (err) {
                    logger.debug(`[MemoryManager] 中转尝试${attempt}失败: ${err.message}`)
                }
            }
            return ''
        }

        raw = await callRelay()
        let obj = parseJson(raw)

        if (!obj.topics && !obj.relations && !obj.summary) {
            throw new Error('中转站暂时不可用或未返回有效 JSON，请稍后重试')
        }

        obj = parseJson(raw)
        if (!obj.topics && !obj.relations && !obj.summary) {
            throw new Error('模型没有返回有效 JSON：' + String(raw).trim().slice(0, 80))
        }
        const topics = (obj.topics || []).map(x => String(x).trim()).filter(Boolean).slice(0, 12)
        const relations = (obj.relations || []).map(x => String(x).trim()).filter(Boolean).slice(0, 12)
        const summary = String(obj.summary || '').trim()
        if (!topics.length && !relations.length && !summary) {
            throw new Error('模型没有返回有效 JSON：' + raw.slice(0, 80))
        }

        const db = databaseService.db
        if (db) {
            const now = Date.now()
            const uid = `群${gid}`
            const del = db.prepare("DELETE FROM structured_memories WHERE group_id = ? AND source = 'manual_summary'")
            const ins = db.prepare(`
                INSERT INTO structured_memories
                (user_id, group_id, category, sub_type, content, confidence, source, metadata, created_at, updated_at, expires_at, is_active)
                VALUES (?, ?, ?, 'general', ?, 0.85, 'manual_summary', NULL, ?, ?, NULL, 1)
            `)
            db.transaction(() => {
                del.run(gid)
                for (const t of topics) ins.run(uid, gid, 'topic', t, now, now)
                for (const r of relations) ins.run(uid, gid, 'relation', r, now, now)
                if (summary) ins.run(uid, gid, 'summary', summary, now, now)
            })()
        }

        // 群总结同时写入知识图谱（群级 scope）
        // 直接用总结出的话题/关系构建，避免再花一次 LLM 调用（之前那次常返回空文本）
        if (config.get('memory.knowledgeGraph') !== false && config.get('memory.knowledgeGraphExtraction') === true) {
            try {
                const { createHash } = await import('node:crypto')
                const db = databaseService.db
                if (db) {
                    const scopeId = `group:${gid}`
                    const now = Date.now()
                    const hash = v => createHash('md5').update(String(v)).digest('hex').slice(0, 8)
                    const findEntity = db.prepare('SELECT entity_id FROM kg_entities WHERE scope_id = ? AND name = ? LIMIT 1')
                    const insEntity = db.prepare(`
                        INSERT INTO kg_entities (entity_id, entity_type, name, scope_id, properties, embedding, created_at, updated_at, version)
                        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1)
                    `)
                    const findRel = db.prepare(
                        'SELECT relationship_id FROM kg_relationships WHERE scope_id = ? AND from_entity_id = ? AND to_entity_id = ? AND relation_type = ? LIMIT 1'
                    )
                    const insRel = db.prepare(`
                        INSERT INTO kg_relationships (relationship_id, from_entity_id, to_entity_id, relation_type, properties, scope_id, created_at, updated_at, version)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                    `)
                    const ensureEntity = (name, type, props = {}) => {
                        const n = String(name || '').trim()
                        if (!n) return null
                        const found = findEntity.get(scopeId, n)
                        if (found) return found.entity_id
                        const eid = `${scopeId}:entity:${hash(n + '|' + type)}`
                        insEntity.run(eid, type, n, scopeId, JSON.stringify(props), now, now)
                        return eid
                    }
                    let addedEntities = 0
                    let addedRelations = 0
                    db.transaction(() => {
                        for (const t of topics) {
                            const n = String(t || '').trim()
                            if (!n) continue
                            if (!findEntity.get(scopeId, n)) {
                                ensureEntity(n, 'concept')
                                addedEntities++
                            }
                        }
                        for (const r of relations) {
                            const text = String(r || '')
                            const people = []
                            const re = /([^()（）和,，、:：]{1,20})[（(](\d{5,12})[)）]/g
                            let m
                            while ((m = re.exec(text)) !== null) people.push({ name: m[1].trim(), qq: m[2] })
                            if (people.length < 2) continue
                            const ids = []
                            for (const person of people.slice(0, 2)) {
                                const before = findEntity.get(scopeId, person.name)
                                const eid = ensureEntity(person.name, 'person', { qq: person.qq })
                                if (!before) addedEntities++
                                ids.push(eid)
                            }
                            if (ids[0] && ids[1] && ids[0] !== ids[1]) {
                                if (!findRel.get(scopeId, ids[0], ids[1], 'knows')) {
                                    insRel.run(
                                        `rel:${hash(ids[0] + ids[1] + 'knows')}`,
                                        ids[0],
                                        ids[1],
                                        'knows',
                                        JSON.stringify({ 描述: text.slice(0, 120) }),
                                        scopeId,
                                        now,
                                        now
                                    )
                                    addedRelations++
                                }
                            }
                        }
                    })()
                    logger.mark(`[MemoryManager] 群总结已写入知识图谱: 新增实体${addedEntities} 关系${addedRelations}`)
                }
            } catch (err) {
                logger.warn('[MemoryManager] 知识图谱写入异常:', err.message)
            }
        }

        return { messageCount: lines.length, topics, relations, summary }
    }

    _syncGroupMemoriesToStructured(groupId, topics = [], relations = []) {
        if ((!topics || !topics.length) && (!relations || !relations.length)) return
        const db = databaseService.db
        if (!db) return
        const gid = String(groupId)
        const now = Date.now()
        const del = db.prepare(
            "DELETE FROM structured_memories WHERE group_id = ? AND source = 'group_context' AND category IN ('topic','relation')"
        )
        const ins = db.prepare(`
            INSERT INTO structured_memories
            (user_id, group_id, category, sub_type, content, confidence, source, metadata, created_at, updated_at, expires_at, is_active)
            VALUES (?, ?, ?, 'general', ?, 0.6, 'group_context', NULL, ?, ?, NULL, 1)
        `)
        const tx = db.transaction(() => {
            del.run(gid)
            for (const t of topics) ins.run(`群${gid}`, gid, 'topic', String(t), now, now)
            for (const r of relations) ins.run(`群${gid}`, gid, 'relation', String(r), now, now)
        })
        tx()
    }

    /** 判断是不是模型跑偏的无效记忆（描述"没有发言"之类） */
    /** 把 LLM 的 JSON 输出转成内部的【用户】【话题】【关系】行；解析失败返回 null */
    _jsonToMemoryLines(text) {
        const raw = String(text || '').trim()
        if (!raw) return null
        let s = raw.replace(/```json/gi, '```').replace(/```/g, '').trim()
        const objStart = s.indexOf('{')
        const arrStart = s.indexOf('[')
        let start = -1
        if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) start = arrStart
        else if (objStart >= 0) start = objStart
        if (start < 0) return null
        const open = s[start]
        const close = open === '{' ? '}' : ']'
        const end = s.lastIndexOf(close)
        if (end <= start) return null
        let data
        try {
            data = JSON.parse(s.slice(start, end + 1))
        } catch {
            return null
        }
        const items = Array.isArray(data) ? data : data.memories || data.items || data.data
        if (!Array.isArray(items)) return null
        const lines = []
        for (const it of items) {
            if (typeof it === 'string') {
                if (it.trim()) lines.push(it.trim())
                continue
            }
            if (!it || typeof it !== 'object') continue
            const type = String(it.type || it.category || '').toLowerCase()
            const content = String(it.content || it.text || it.memory || it.value || '').trim()
            if (!content) continue
            const name = String(it.name || it.nickname || it.user || '').trim()
            if ((type === 'user' || type === '用户') && name) lines.push(`【用户:${name}】${content}`)
            else if (type === 'topic' || type === '话题') lines.push(`【话题】${content}`)
            else if (type === 'relation' || type === '关系') lines.push(`【关系】${content}`)
            else lines.push(content)
        }
        return lines
    }

    _isJunkMemoryLine(text) {
        const t = String(text || '').trim()
        if (t.length < 4) return true
        if (/^(用户|群友|助手|系统)\s*[:：]/.test(t)) return true
        if (/没有.{0,6}(发言|说过话|内容|信息)/.test(t)) return true
        if (/本次要总结|无法提取|暂无可提取|没有可提取|本次对话/.test(t)) return true
        if (/^[\[【]?群友\[/.test(t)) return true
        if (/无具体个人信息|无信息|无个人信息|提及用户|说了几句话/.test(t)) return true
        if (/撤回了一条.{0,6}消息/.test(t)) return true
        if (/^["“][^"”]{0,30}["”]\s*[-—]/.test(t)) return true
        if (/没有透露|没有新的?.{0,8}信息|输出\s*["“]?无|已在记忆中/.test(t)) return true
        if (/^现有记忆[:：]?$/.test(t)) return true
        if (/^["“]?无["”]?[。.!！]?$/.test(t)) return true
        if (/最新对话中|用户(说|问)了?[:：]?$/.test(t)) return true
        if (/^["“][^"”]{0,40}["”]$/.test(t)) return true
        if (/^(但|不过|然而|所以|因此|现有记忆|保留)/.test(t)) return true
        if (/可以保留|有点重复|输出一条|是否明确|已足够|无需新增/.test(t)) return true
        if (/现有记忆|需要合并|规则(说|要求)|输出应该|等等|助手\.\.\.|\.\.\.$/.test(t)) return true
        if (/在对话中说了/.test(t)) return true
        if (/^["“][^"”]*["”]\s*[（(]/.test(t)) return true
        if (/(对话|消息|聊天)记录|只发了|只说了|原话/.test(t)) return true
        if (/^\[[^\]]+\](\[[^\]]*\])?\s*[:：]/.test(t)) return true
        if (/^\[[^\]]+\]\s*\[/.test(t)) return true
        if (/^\[[^\]]+\]\s*叫/.test(t)) return true
        if (/^(这些|其他|最新|该用户|综上|注[:：]|说明[:：]|这条|但再|可能矛盾|需要合并)/.test(t)) return true
        if (/^(Final|Need|Let me|I |The |Consider|Wait|Okay|Sure|Output|We |And |But )/i.test(t)) return true
        if (/only json|json only|output json|JSON\.?$/i.test(t)) return true
        if (/^(分析|思考|推理|判断|结论)[:：]/.test(t)) return true
        if (/[:：]\s*$/.test(t)) return true
        return false
    }

    /** 根据内容粗略推断分类，够 Web 展示用 */
    _inferMemoryCategory(text) {
        const t = String(text || '')
        if (/偏好|喜欢|讨厌|爱吃|爱喝|不爱|最爱|怕|过敏/.test(t)) return 'preference'
        if (/关系|朋友|姐姐|哥哥|妹妹|弟弟|师父|师祖|师姐|师兄|老婆|老公|对象|情侣|认识/.test(t)) return 'relation'
        if (/话题|讨论|聊到|提到/.test(t)) return 'topic'
        return 'profile'
    }

    /** 把用户记忆同步到 structured_memories（Web 记忆管理读这张表） */
    _syncUserMemoriesToStructured(userId, groupId, memories, source = 'summary') {
        const db = databaseService.db
        if (!db) return
        const uid = String(userId ?? '').replace(/\.0+$/, '').trim()
        if (!uid) return
        const gid = groupId === undefined || groupId === null || groupId === '' ? null : String(groupId)
        const valid = (memories || [])
            .map(m => (typeof m === 'string' ? m : m?.content))
            .map(t => String(t || '').trim())
            .filter(t => t && !this._isJunkMemoryLine(t))
        if (!valid.length) return

        const now = Date.now()
        const del = gid
            ? db.prepare("DELETE FROM structured_memories WHERE user_id = ? AND group_id = ? AND source = 'memory_summary'")
            : db.prepare("DELETE FROM structured_memories WHERE user_id = ? AND group_id IS NULL AND source = 'memory_summary'")
        const ins = db.prepare(`
            INSERT INTO structured_memories
            (user_id, group_id, category, sub_type, content, confidence, source, metadata, created_at, updated_at, expires_at, is_active)
            VALUES (?, ?, ?, 'general', ?, 0.7, 'memory_summary', NULL, ?, ?, NULL, 1)
        `)
        const tx = db.transaction(() => {
            del.run(...(gid ? [uid, gid] : [uid]))
            for (const text of valid) {
                ins.run(uid, gid, this._inferMemoryCategory(text), text, now, now)
            }
        })
        tx()
    }

    _isInvalidMemoryLine(line) {
        const trimmed = line.trim()

        // 长度检查
        if (trimmed.length < 3 || trimmed.length > 200) return true

        const invalidPatterns = [
            // 英文分析标题
            /^(identifying|understanding|pinpointing|interpreting|decoding|analyzing)/i,
            /^(personal data|user goals|user identity|user intent|dialogue structure)/i,
            /^(summary|conclusion|analysis|result|output|note)/i,
            // 中文分析标题
            /^(提取|分析|总结|理解|识别|归纳|整理|梳理)/,
            /^(步骤|第[一二三四五六七八九十]|\d+\.|\d+、|\d+\))/,
            /^(以下是|根据|综合|结合|通过|经过)/,
            /^(用户信息|话题|关系|记忆|内容)[:：]?\s*$/,
            // 分隔符和空内容
            /^[-=*#]{3,}/,
            /^[【\[].+[】\]][:：]?\s*$/, // 纯标题行如【用户信息】
            /^无$/,
            /^暂无$/,
            /^没有/,
            /^无有效/,
            // AI常见废话
            /^好的|^明白|^收到|^了解/,
            /^根据对话|^从对话中|^在对话中/,
            // 引用AI回复的错误记忆
            /^助手[:：]/,
            /^AI[:：]/,
            /^机器人[:：]/
        ]

        for (const pattern of invalidPatterns) {
            if (pattern.test(trimmed)) return true
        }
        return false
    }

    /**
     * 获取群聊相关记忆
     * @param {string} groupId - 群ID
     * @param {string} [userId] - 可选的用户ID
     * @param {Object} [options] - 选项
     * @param {string} [options.nickname] - 用户昵称（用于按昵称查找记忆）
     * @returns {Object} 群聊记忆上下文
     */
    async getGroupMemoryContext(groupId, userId = null, options = {}) {
        await this.init()
        const { nickname } = options

        const result = {
            userInfo: [],
            topics: [],
            relations: []
        }

        try {
            // 获取用户信息记忆（按userId）
            if (userId) {
                const userMemories = databaseService.getMemories(`group:${groupId}:user:${userId}`, 5)
                result.userInfo.push(...userMemories.map(m => m.content))
            }

            // 获取用户信息记忆（按昵称）- 支持按昵称存储的记忆格式
            if (nickname) {
                const nicknameMemories = databaseService.getMemories(`group:${groupId}:user:${nickname}`, 5)
                for (const m of nicknameMemories) {
                    if (!result.userInfo.includes(m.content)) {
                        result.userInfo.push(m.content)
                    }
                }
            }

            // 获取话题记忆
            const topicMemories = databaseService.getMemories(`group:${groupId}:topics`, 5)
            result.topics = topicMemories.map(m => m.content)

            // 获取关系记忆
            const relationMemories = databaseService.getMemories(`group:${groupId}:relations`, 5)
            result.relations = relationMemories.map(m => m.content)
        } catch (error) {
            logger.debug(`[MemoryManager] 获取群 ${groupId} 记忆失败:`, error.message)
        }

        return result
    }

    /**
     * 获取群聊上下文
     * @param {string} groupId - 群ID
     * @returns {Object} 群聊记忆
     */
    async getGroupContext(groupId) {
        await this.init()

        const result = {
            topics: [],
            relations: [],
            userInfos: []
        }

        try {
            // 获取话题记忆
            result.topics = databaseService.getMemories(`group:${groupId}:topics`, 20)

            // 获取关系记忆
            result.relations = databaseService.getMemories(`group:${groupId}:relations`, 20)

            // 获取群内用户记忆（按前缀查询）
            result.userInfos = databaseService.getMemoriesByPrefix(`group:${groupId}:user:`, 30)
        } catch (error) {
            logger.debug(`[MemoryManager] 获取群 ${groupId} 上下文失败:`, error.message)
        }

        return result
    }

    /**
     * 停止轮询
     */
    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval)
            this.pollInterval = null
            logger.debug('[MemoryManager] 停止周期轮询')
        }
        if (this.groupContextInterval) {
            clearInterval(this.groupContextInterval)
            this.groupContextInterval = null
            logger.debug('[MemoryManager] 停止群聊上下文采集')
        }
    }

    /**
     * 轮询所有活跃用户，分析对话并提取记忆
     */
    async pollAndSummarize() {
        if (!config.get('memory.enabled')) return

        try {
            // 获取最近有对话的用户
            const conversations = databaseService.getConversations()
            // 私聊按用户去重；共享群必须按「群 + 持久化发送者」去重，不能把群 ID 当用户 ID。
            const processedUsers = new Set()
            const minPollInterval = (config.get('memory.minPollInterval') || 30) * 60 * 1000 // 默认30分钟
            const now = Date.now()

            for (const conv of conversations) {
                // group_summary_* 是群消息缓冲，不是用户，喂给记忆总结纯属烧钱
                if (typeof conv.id === 'string' && conv.id.startsWith('group_summary_')) continue
                const sharedGroupConversation = typeof conv.id === 'string' && /^group:[^:]+$/.test(conv.id)
                const targets = []

                if (sharedGroupConversation) {
                    const groupId = conv.id.slice('group:'.length)
                    const senderIds = new Set()
                    const history = databaseService.getMessages(conv.id, 1000)

                    // 只信任落库时保存的 sender.user_id。旧记录没有 sender 时无法确认归属，必须跳过。
                    for (let index = history.length - 1; index >= 0; index--) {
                        const message = history[index]
                        if (message.role !== 'user') continue
                        const senderId = message.sender?.user_id
                        if (senderId === null || senderId === undefined || String(senderId) === '') continue
                        senderIds.add(String(senderId))
                    }

                    if (senderIds.size === 0) {
                        logger.debug(`[MemoryManager] 共享群会话缺少可确认 sender，跳过自动记忆总结: ${conv.id}`)
                        continue
                    }

                    for (const userId of senderIds) {
                        targets.push({
                            userId,
                            pollKey: `group:${groupId}:user:${userId}`,
                            options: { groupId }
                        })
                    }
                } else {
                    const userId = String(conv.userId ?? '')
                    if (!userId) continue
                    targets.push({ userId, pollKey: userId, options: undefined })
                }

                for (const target of targets) {
                    if (processedUsers.has(target.pollKey)) continue
                    processedUsers.add(target.pollKey)

                    // 合并内存（快路径）与 kv_store（跨进程重启）游标，见 _resolvePollCursor
                    const { effectiveTs: lastPoll } = this._resolvePollCursor(target.pollKey)
                    if (now - lastPoll < minPollInterval) continue

                    // 检查对话是否有新消息（距离上次轮询后是否有新对话）
                    const convTime = conv.updatedAt || conv.timestamp || 0
                    if (convTime <= lastPoll) continue

                    // 共享群携带精确 groupId，使 listUserConversations 只读取当前群并按 sender 归属轮次。
                    // since 让总结只看游标之后的新消息，避免每轮重复总结旧上下文
                    await this.analyzeUserConversations(target.userId, { ...(target.options || {}), since: lastPoll })
                    this.lastPollTime.set(target.pollKey, now)
                    this._capTimeMap(this.lastPollTime)
                    try {
                        databaseService.setKV(`${POLL_KV_PREFIX}${target.pollKey}`, now)
                    } catch (err) {
                        logger.debug('[MemoryManager] 写入轮询 KV 游标失败:', err.message)
                    }

                    // 避免一次处理太多用户
                    if (processedUsers.size >= 100) break
                }

                // 避免一次处理太多用户，限制单次轮询最多处理10个用户
                if (processedUsers.size >= 100) {
                    logger.debug(`[MemoryManager] 单次轮询处理了 ${processedUsers.size} 个用户，等待下次轮询`)
                    break
                }
            }

            if (processedUsers.size > 0) {
                logger.debug(`[MemoryManager] 本次轮询处理了 ${processedUsers.size} 个用户`)
            }
        } catch (error) {
            logger.warn('[MemoryManager] 轮询处理失败:', error.message)
        }
    }

    /**
     * 分析用户最近的对话，提取并总结记忆
     * @param {string} userId
     */
    async analyzeUserConversations(userId, options = {}) {
        let startTime2 = null
        let channelInfo2 = null
        let model2 = null
        let groupId = undefined

        try {
            const analysisOptions = { groupId: undefined, ...options }
            groupId = analysisOptions.groupId
            const memoryUserId = this.getScopedMemoryUserId(userId, groupId)

            const conversations = databaseService.listUserConversations(userId, {
                ...(groupId !== undefined ? { groupId } : {})
            })
            if (conversations.length === 0) {
                return { success: false, error: '没有找到可总结的对话记录', reason: 'no_conversation' }
            }

            let recentConv = null
            let messages = []
            for (const conversation of conversations) {
                const isGroupConv = String(conversation.conversationId || '').startsWith('group:')
                const convMessages = isGroupConv
                    ? databaseService.getMessages(conversation.conversationId, 30)
                    : databaseService.getMessagesForUser(conversation.conversationId, userId, 30)
                if (
                    convMessages.filter(message => message.role === 'user' || message.role === 'assistant').length >= 2
                ) {
                    recentConv = conversation
                    messages = convMessages
                    break
                }
            }
            if (!recentConv) {
                return {
                    success: false,
                    error: '对话记录缺少可确认归属的用户消息，无法安全总结',
                    reason: 'insufficient_attributed_messages'
                }
            }

            const isGroupConversation = recentConv.conversationId.startsWith('group:')

            // 只保留游标之后的新消息，避免每 2 小时重复总结同一段旧上下文
            const since = Number(options?.since) || 0
            if (since > 0) {
                messages = messages.filter(m => Number(m.timestamp || 0) > since)
            }
            if (messages.length === 0) {
                return { success: false, error: '游标之后没有新消息', reason: 'no_new_messages' }
            }

            // 群聊消息里可能包着 bym 的【最近群聊记录】/【本轮上下文】块，剥掉后再判断内容量
            const cleanContent = text =>
                String(text || '')
                    .replace(/【最近群聊记录】[\s\S]*?(?:请基于以上聊天记录[^\n]*|$)/g, ' ')
                    .replace(/【本轮上下文[^\n]*】[\s\S]*?【以上是上下文[^\n]*】/g, ' ')
                    .trim()

            let cleanedChars = 0
            const dialogText = messages
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .map(m => {
                    const raw = Array.isArray(m.content)
                        ? m.content
                              .filter(c => c.type === 'text')
                              .map(c => c.text)
                              .join('')
                        : typeof m.content === 'string'
                          ? m.content
                          : ''
                    const content = cleanContent(raw)
                    if (content.length < 2) return ''
                    cleanedChars += content.length
                    if (m.role === 'assistant') return `助手: ${content.substring(0, 200)}`
                    const senderId = String(m.sender?.user_id ?? m.sender?.userId ?? m.userId ?? '')
                    // 群聊里归属不明（旧记录无 sender）的消息直接丢弃，避免把群友的话记到用户头上
                    if (isGroupConversation && !senderId) return ''
                    const name = m.sender?.card || m.sender?.nickname || senderId || '未知'
                    const label = senderId ? `${name}(${senderId})` : name
                    return `[${label}]: ${content.substring(0, 200)}`
                })
                .filter(Boolean)
                .join('\n')

            // 本次要总结的人：昵称(QQ)，避免提示词里出现“用户”这种泛指
            const targetMsg = messages.find(
                m => String(m.sender?.user_id ?? m.sender?.userId ?? m.userId ?? '') === String(userId)
            )
            const targetName = targetMsg?.sender?.card || targetMsg?.sender?.nickname || String(userId)
            const targetLabel = `${targetName}(${userId})`

            // 群友聊天也算触发，但清洗后完全没有内容就不调用 LLM
            if (cleanedChars < 10 || dialogText.length < 10) {
                return { success: false, error: '新消息没有有效内容，跳过总结', reason: 'insufficient_content' }
            }

            // 获取现有记忆用于合并总结
            const existingMemories = databaseService.getMemories(memoryUserId, 50)
            const existingMemoryList = existingMemories.map(m => `- ${m.content}`).join('\n')

            const botName = global.Bot?.nickname || config.get('basic.botName') || '助手'
            const contextHint = isGroupConversation
                ? `这是【群聊】中的对话记录。
- 每条消息格式为 [昵称(QQ号)]: 内容
- 本次要总结的人是 ${targetLabel}，只提取此人明确说出的信息
- 其他 [昵称(QQ号)] 的发言只作为话题背景，不要记到 ${targetLabel} 名下`
                : `这是【私聊】对话，每条消息格式为 [昵称(QQ号)]: 内容，本次要总结的人是 ${targetLabel}。`

            // 覆盖式总结prompt - 改进版：更准确区分用户身份
            const prompt = `你是用户记忆管理专家。分析对话，提取用户透露的个人信息。

【重要规则】
${contextHint}
- "助手:"或"${botName}"是机器人/AI的回复，绝对不是用户信息
- 只记录用户自己明确说出的具体信息
- 不要推测或臆断用户信息
- 不要把AI回复的内容当成用户信息

【现有记忆】
${existingMemoryList || '暂无'}

【最新对话】
${dialogText}

【提取类型】
- 基本信息：姓名、年龄、职业、所在地等
- 偏好习惯：喜欢/不喜欢的事物
- 重要事件：生日、纪念日、计划等
- 个性特点：兴趣爱好、性格等

【总结要求】
1. 合并现有记忆和新信息，删除重复、过时或已被推翻的条目
2. 每条必须是用户明确说过的具体事实，不超过50字
3. 全部用中文书写
4. 只保留长期稳定的信息：身份、所在地、职业、长期偏好、人际关系、计划、雷点
5. 不要记录游戏进度/数值/装备、一次性操作、群内打招呼、开关设置、临时状态
6. 不要以“用户提到…”“用户要求…”“用户选择…”开头
7. 只记录 ${targetLabel} 本人的信息；助手回复和其他 [昵称(QQ)] 提到的他人信息，不能记到该人名下
8. 内容里出现别人的 QQ/群名片（与 ${userId} 不一致）时不要记录；称谓必须逐字引用，“师祖”不能写成“师姐”
9. 每条记忆必须以“昵称(QQ号)”开头，例如“宝了个贝(203231682) 喜欢打游戏”，不要写“用户”“该用户”“本人”

【输出格式（严格 JSON）】
只输出一个 JSON 对象，不要 markdown 代码块、不要解释、不要思考过程：
{"memories":[{"category":"profile","content":"宝了个贝(203231682) 不超过50字的具体事实"}]}
category 可选：profile（基本信息/性格）、preference（偏好习惯）、relation（人际关系）、topic（长期话题）。
最多10条；没有任何值得记录的信息时输出：{"memories":[]}`

            startTime2 = Date.now()
            const memoryModel2 = config.get('memory.model')
            const client = await LlmService.getChatClient({
                model: memoryModel2 || undefined,
                ...(groupId !== null && groupId !== undefined && groupId !== '' ? { groupId: String(groupId) } : {})
            })
            channelInfo2 = client._channelInfo || {}
            model2 = channelInfo2.model || config.get('llm.defaultModel')
            const _temp2 = resolveClientTemperature(client, 0.3)
            const result = await this._sendMemoryLlm(
                client,
                { role: 'user', content: [{ type: 'text', text: prompt }] },
                {
                    model: model2,
                    maxToken: 500,
                    disableHistorySave: true,
                    ...(_temp2 !== undefined ? { temperature: _temp2 } : {})
                },
                'MemoryAnalyzeUser'
            )

            const responseText = result.contents?.[0]?.text?.trim() || ''

            // 覆写旧 memories 表前，不是纯文本就原样解析；语言字数不够则按现状读取
            const jsonUserLines = this._jsonToMemoryLines(responseText)
            const memoryLines = jsonUserLines || responseText
                .split(/\r?\n/)
                .map(line =>
                    String(line || '')
                        .trim()
                        .replace(/^[-*•+]+\s*/, '')
                        .replace(/^\d+[.)、]\s*/, '')
                )
                .filter(
                    line =>
                        line &&
                        line !== '无' &&
                        !/^(?:注意|所以|因此|我们|需要|应该|可以|首先|其次|最后|综上|接下来|说明|备注|输出|整理|合并)/.test(
                            line
                        )
                )
            // 记录统计
            try {
                const recordSuccess = typeof responseText === 'string' && responseText.length > 0
                await statsService.recordApiCall({
                    channelId: channelInfo2.id || 'memory',
                    channelName: channelInfo2.name || '记忆服务',
                    model: model2,
                    reportedModel: result.model || null,
                    duration: Date.now() - startTime2,
                    success: recordSuccess,
                    source: '个人记忆总结',
                    userId,
                    responseText,
                    apiUsage: result.usage,
                    request: { messages: [{ role: 'user', content: prompt }], model: model2 },
                    response: !recordSuccess ? { error: '响应为空' } : null
                })
            } catch (e) {
                /* 统计失败不影响主流程 */
            }

            if (!responseText || responseText === '无' || responseText.length < 5) {
                return { success: false, error: '总结模型未返回有效记忆', reason: 'empty_summary' }
            }

            // 解析新记忆列表
            const newMemories = this._parseMemoryResponse(
                memoryLines.length > 0 ? memoryLines.join('\n') : responseText
            )

            if (newMemories.length === 0) {
                return { success: false, error: '总结结果没有可保存的记忆条目', reason: 'invalid_summary' }
            }

            // 写入前过滤临时/游戏进度类内容
            const durableMemories = newMemories.filter(
                m => !isTransientMemory(m) && !mentionsOtherQQ(m, userId)
            )
            if (durableMemories.length === 0) {
                logger.debug('[MemoryManager] 总结结果全部为临时内容，跳过写入')
                return { success: false, error: '总结结果均为临时内容', reason: 'all_transient' }
            }
            if (durableMemories.length !== newMemories.length) {
                logger.debug(`[MemoryManager] 过滤临时记忆 ${newMemories.length - durableMemories.length} 条`)
            }

            // 覆盖式替换：清除旧记忆，保存新记忆
            const replaced = await this.replaceUserMemories(userId, durableMemories, 'poll_summary', { groupId })
            if (!replaced) {
                return { success: false, error: '写入总结结果失败', reason: 'replace_failed' }
            }
            logger.debug(`[MemoryManager] 覆盖式总结完成 [${userId}]: ${newMemories.length}条记忆`)
            return {
                success: true,
                conversationId: recentConv.conversationId,
                memoryCount: newMemories.length
            }
        } catch (error) {
            logger.debug(`[MemoryManager] 分析用户 ${userId} 对话失败:`, error.message)
            try {
                await statsService.recordApiCall({
                    channelId: channelInfo2?.id || 'memory',
                    channelName: channelInfo2?.name || '记忆服务',
                    model: model2 || config.get('llm.defaultModel'),
                    duration: startTime2 ? Date.now() - startTime2 : 0,
                    success: false,
                    error: error.message || String(error),
                    source: '个人记忆总结',
                    userId,
                    ...(groupId !== undefined && groupId !== null && groupId !== '' ? { groupId } : {})
                })
            } catch (e) {
                /* 统计失败不影响主流程 */
            }
            return { success: false, error: error.message, reason: 'exception' }
        }
    }

    /**
     * 解析记忆响应文本，过滤无效内容
     * @param {string} responseText
     * @returns {string[]}
     */
    _parseMemoryResponse(responseText) {
        // 无效内容的特征模式
        const invalidPatterns = [
            /^(identifying|understanding|pinpointing|interpreting|decoding|analyzing)/i,
            /^(personal data|user goals|user identity|user intent|dialogue structure)/i,
            /^(提取|分析|总结|理解|识别)/,
            /^(步骤|第[一二三四五]|\d+\.|\d+、)/,
            /^(以下是|根据|综合|结合)/,
            /^[-=]{3,}/, // 分隔线
            /^[【\[].+[】\]]:?$/, // 纯标题行
            /^(?:注意|所以|因此|我们|需要|应该|可以|首先|其次|最后|综上|接下来|说明|备注|输出|整理|合并)/ // 思考/元叙述引导语
        ]

        return responseText
            .split('\n')
            .map(line => line.replace(/^[-•\*\d.)、\s]+/, '').trim())
            .filter(line => {
                // 长度检查
                if (line.length < 5 || line.length > 100) return false
                if (line === '无') return false
                // 无效模式检查
                for (const pattern of invalidPatterns) {
                    if (pattern.test(line)) return false
                }
                return true
            })
            .slice(0, 15) // 最多15条
    }

    /**
     * 生成旧版 memories 表使用的作用域键。
     * 群内记忆沿用历史固定前缀，QQBot OpenID 与频道标识按原值保留。
     * @param {string|number} userId - 用户标识
     * @param {string|number|null|undefined} groupId - 群或频道标识
     * @returns {string} memories 表中的用户键
     */
    getScopedMemoryUserId(userId, groupId = undefined) {
        const normalizedUserId = String(userId ?? '')
        if (groupId === undefined || groupId === null || groupId === '') return normalizedUserId
        return `group:${String(groupId)}:user:${normalizedUserId}`
    }

    /**
     * 覆盖式替换用户记忆
     * @param {string} userId
     * @param {string[]} memories - 新记忆列表
     * @param {string} source - 来源标记
     */
    async replaceUserMemories(userId, memories, source = 'summary', options = {}) {
        try {
            await this.init()
            const storageUserId = this.getScopedMemoryUserId(userId, options?.groupId)

            // 清除旧记忆与写入新记忆在同一事务内完成，
            // 否则中途失败会导致旧记忆已删、新记忆未写，用户记忆永久丢失
            const replacedAt = Date.now()
            const written = databaseService.replaceMemories(
                storageUserId,
                (memories || []).map(content => ({
                    content,
                    source,
                    importance: 6,
                    metadata: { replacedAt }
                }))
            )

            try {
                this._syncUserMemoriesToStructured(userId, options?.groupId, memories || [], source)
            } catch (err) {
                logger.debug('[MemoryManager] 同步用户记忆到结构化失败:', err.message)
            }

            logger.debug(`[MemoryManager] 替换记忆 [${storageUserId}]: ${written}条`)
            return true
        } catch (error) {
            logger.error(`[MemoryManager] 替换记忆失败 [${userId}]:`, error.message)
            return false
        }
    }

    /**
     * 从对话中自动提取记忆
     * @param {string} userId
     * @param {string} userMessage
     * @param {string} assistantResponse
     */
    async extractMemoryFromConversation(userId, userMessage, assistantResponse, options = {}) {
        if (!config.get('memory.enabled')) return

        let startTime3 = null
        let channelInfo3 = null
        let model3 = null

        try {
            const storageUserId = this.getScopedMemoryUserId(userId, options?.groupId)
            // 判断是否包含值得记忆的信息（放宽触发门槛，让自然陈述也能进入 LLM 兜底判定）
            const importantPatterns = [
                /我(是|叫|住在|喜欢|讨厌|不喜欢|今年|的生日|工作|最近|觉得|需要|想|要|养|做过)/,
                /我的(名字|职业|年龄|爱好|家人|兴趣|习惯)/,
                /记住/,
                /别忘了/,
                /以后/,
                /(不再|改主意|其实|更正)/,
                /刚(买|换|搬|找到|进)/
            ]

            const shouldExtract = importantPatterns.some(p => p.test(userMessage))
            if (!shouldExtract) return null

            // 获取现有记忆用于合并
            const existingMemories = databaseService.getMemories(storageUserId, 20)
            const existingMemoryList = existingMemories.map(m => `- ${m.content}`).join('\n')

            const botName = global.Bot?.nickname || config.get('basic.botName') || '助手'

            // 校验现有记忆，识别否定/纠正（改主意）的情况，避免覆盖式提取丢条或保留矛盾信息
            const mergePrompt = `你是用户记忆管理专家。请综合现有记忆和新对话，生成更新后的完整记忆列表。

【现有记忆】
${existingMemoryList || '暂无'}

【新对话】
用户说：${userMessage}
助手回复：${assistantResponse}

【规则】
1. 只记录用户（人类）透露的具体个人信息
2. 助手/${botName}是机器人，不要记录机器人的信息
3. 合并现有记忆和新信息，删除重复项
4. 用户推翻旧信息（如"其实我不喜欢X了""我改主意了"）时，用新信息替换旧信息
5. 每条记忆必须是具体事实，不超过50字
6. 不要输出标题、序号或格式说明

【输出格式】
直接输出记忆内容，每行一条，最多10条。无有效信息则输出"无"：`

            startTime3 = Date.now()
            const memoryModel3 = config.get('memory.model')
            const client = await LlmService.getChatClient({
                model: memoryModel3 || undefined,
                ...(options?.groupId !== undefined && options?.groupId !== null && options?.groupId !== ''
                    ? { groupId: String(options.groupId) }
                    : {})
            })
            channelInfo3 = client._channelInfo || {}
            model3 = channelInfo3.model || config.get('llm.defaultModel')
            const _temp3 = resolveClientTemperature(client, 0.3)
            const result = await this._sendMemoryLlm(
                client,
                { role: 'user', content: [{ type: 'text', text: mergePrompt }] },
                {
                    model: model3,
                    maxToken: 400,
                    disableHistorySave: true,
                    ...(_temp3 !== undefined ? { temperature: _temp3 } : {})
                },
                'MemoryAutoExtract'
            )

            const responseText = result.contents?.[0]?.text?.trim()
            try {
                const recordSuccess = typeof responseText === 'string' && responseText.length > 0
                await statsService.recordApiCall({
                    channelId: channelInfo3.id || 'memory',
                    channelName: channelInfo3.name || '记忆服务',
                    model: model3,
                    reportedModel: result.model || null,
                    duration: Date.now() - startTime3,
                    success: recordSuccess,
                    source: '记忆提取',
                    userId,
                    responseText: responseText || '',
                    apiUsage: result.usage,
                    request: { messages: [{ role: 'user', content: mergePrompt }], model: model3 },
                    response: !recordSuccess ? { error: '响应为空' } : null
                })
            } catch (e) {
                /* 统计失败不影响主流程 */
            }

            if (!responseText || responseText === '无' || responseText.length < 5) return null

            // 解析并覆盖替换记忆
            let newMemories = this._parseMemoryResponse(responseText)
            newMemories = newMemories.filter(m => !isTransientMemory(m) && !mentionsOtherQQ(m, userId))
            if (newMemories.length > 0) {
                await this.replaceUserMemories(userId, newMemories, 'auto_extract', options)
                logger.debug(`[MemoryManager] 自动提取并合并记忆: ${newMemories.length}条`)
                return newMemories.join('; ')
            }
        } catch (error) {
            logger.warn('[MemoryManager] 自动提取记忆失败:', error.message)
            try {
                await statsService.recordApiCall({
                    channelId: channelInfo3?.id || 'memory',
                    channelName: channelInfo3?.name || '记忆服务',
                    model: model3 || config.get('llm.defaultModel'),
                    duration: startTime3 ? Date.now() - startTime3 : 0,
                    success: false,
                    error: error.message || String(error),
                    source: '记忆提取',
                    userId,
                    ...(options?.groupId !== undefined && options?.groupId !== null && options?.groupId !== ''
                        ? { groupId: options.groupId }
                        : {})
                })
            } catch (e) {
                /* 统计失败不影响主流程 */
            }
        }
        return null
    }

    /**
     * 带渠道委托的旁路调用：统一经 LlmDelegator 调度
     * 仅接受内部统一客户端
     * 其他客户端直接拒绝，不再保留直连路径。
     * @param {Object} client - LLM 客户端
     * @param {Object} message - 用户消息（内部格式）
     * @param {Object} requestOptions - 请求选项（含 model/maxToken/temperature 等）
     * @param {string} caller - 调用者标签
     * @returns {Promise<Object>} 客户端响应
     */
    async _sendMemoryLlm(client, message, requestOptions, caller) {
        const isInternalClient =
            typeof client?._channelInfo?.id === 'string' &&
            (typeof client?.sendMessage === 'function' || typeof client?.sendMessageWithHistory === 'function')
        if (!isInternalClient) {
            throw new Error('[MemoryManager] 非内部客户端无法委托调度，请使用 getChatClient 构造客户端')
        }
        const result = await delegateRequest({
            userMessage: message,
            initialModel: requestOptions.model || client._channelInfo?.model,
            initialChannel: client._channelInfo?.channel || null,
            initialClient: client,
            clientBaseOptions: {},
            requestOptions,
            event: null,
            source: caller || 'memory'
        })
        return result.response
    }

    /**
     * 获取用户记忆上下文
     * @param {string} userId
     * @param {string} query
     * @param {Object} options - 选项
     * @param {Object} options.event - 事件对象
     * @param {string} options.groupId - 群ID（用于获取群相关记忆）
     * @param {boolean} options.includeProfile - 是否包含用户画像
     * @returns {string} 格式化的记忆上下文
     */
    async getMemoryContext(userId, query, options = {}) {
        if (!config.get('memory.enabled')) return ''

        await this.init()
        const { groupId } = options
        // QQBot/OpenID 与频道标识可以合法包含下划线；不能再把最后一段猜成 QQ 号。
        // 调用方传入的 userId 已是存储键，必须原样读取。
        const pureUserId = String(userId ?? '')
        let allMemories = []

        // 1. 获取用户基础记忆
        const userMemories = databaseService.getMemories(pureUserId, 10)
        allMemories.push(...userMemories)

        // 2. 如果在群聊中，尝试获取群内用户记忆
        if (groupId) {
            const groupUserKey = `group:${groupId}:user:${pureUserId}`
            const groupUserMemories = databaseService.getMemories(groupUserKey, 5)
            for (const gm of groupUserMemories) {
                if (!allMemories.find(m => m.id === gm.id)) {
                    allMemories.push(gm)
                }
            }
            logger.debug(`[MemoryManager] 群 ${groupId} 用户 ${pureUserId} 加载 ${groupUserMemories.length} 条群内记忆`)
        }

        // 3. 搜索相关记忆
        if (query && query.trim()) {
            const searchedMemories = databaseService.searchMemories(pureUserId, query, 5)
            for (const sm of searchedMemories) {
                if (!allMemories.find(m => m.id === sm.id)) {
                    allMemories.push(sm)
                }
            }
            // 群内搜索
            if (groupId) {
                const groupUserKey = `group:${groupId}:user:${pureUserId}`
                const groupSearched = databaseService.searchMemories(groupUserKey, query, 3)
                for (const gs of groupSearched) {
                    if (!allMemories.find(m => m.id === gs.id)) {
                        allMemories.push(gs)
                    }
                }
            }
        }

        // 4. 兼容旧格式的组合ID
        if (String(userId ?? '').includes('_')) {
            const combinedMemories = databaseService.getMemories(String(userId), 5)
            for (const cm of combinedMemories) {
                if (!allMemories.find(m => m.id === cm.id)) {
                    allMemories.push(cm)
                }
            }
        }

        if (allMemories.length === 0) {
            logger.debug(`[MemoryManager] 用户 ${pureUserId} 无记忆数据`)
            return ''
        }

        // 按重要性和时间排序
        allMemories.sort((a, b) => {
            const importanceA = a.importance || 5
            const importanceB = b.importance || 5
            if (importanceB !== importanceA) return importanceB - importanceA
            return (b.timestamp || 0) - (a.timestamp || 0)
        })

        // 最多取15条
        const selectedMemories = allMemories.slice(0, 15)

        const memoryLines = selectedMemories.map(m => `- ${m.content}`)
        logger.info(
            `[MemoryManager] 为用户 ${pureUserId}${groupId ? ` (群${groupId})` : ''} 加载 ${selectedMemories.length} 条记忆`
        )
        logger.debug(`[MemoryManager] 记忆内容:\n${memoryLines.join('\n')}`)
        return formatUserMemoryBlock(memoryLines)
    }

    /**
     * 保存记忆
     * @param {string} userId
     * @param {string} content
     * @param {Object} options
     */
    async saveMemory(userId, content, options = {}) {
        const isManual = options.source === 'manual' || options.forceManual
        if (!config.get('memory.enabled') && !isManual) return null

        try {
            await this.init()

            // 检查记忆数量上限
            const storageUserId = this.getScopedMemoryUserId(userId, options?.groupId)
            const maxMemories = config.get('memory.maxMemories') || 100
            const existingMemories = databaseService.getMemories(storageUserId, maxMemories + 10)

            // 如果超过上限，删除最旧的记忆
            if (existingMemories.length >= maxMemories) {
                // 按时间排序，保留最新的 maxMemories - 1 条
                const sortedMemories = existingMemories.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                const memoriesToDelete = sortedMemories.slice(maxMemories - 1)
                for (const m of memoriesToDelete) {
                    databaseService.deleteMemory(m.id)
                }
                logger.debug(`[MemoryManager] 清理旧记忆 ${memoriesToDelete.length} 条，用户 ${userId}`)
            }

            const id = databaseService.saveMemory(storageUserId, content, {
                source: options.source || 'manual',
                importance: options.importance || 5,
                metadata: options.metadata || options
            })

            logger.debug(`[MemoryManager] 保存记忆: userId=${storageUserId}, id=${id}`)
            return { id, content, timestamp: Date.now() }
        } catch (error) {
            logger.error(`[MemoryManager] 保存记忆失败:`, error.message)
            return null
        }
    }

    /**
     * 搜索记忆
     * @param {string} userId
     * @param {string} query
     * @param {number} limit
     */
    async searchMemory(userId, query, limit = 5) {
        if (!config.get('memory.enabled')) return []

        await this.init()
        return databaseService.searchMemories(userId, query, limit)
    }

    /**
     * 获取用户所有记忆
     * @param {string} userId
     */
    async getAllMemories(userId) {
        await this.init()
        return databaseService.getMemories(userId, 100)
    }

    /**
     * 删除记忆
     * @param {string} userId
     * @param {number} memoryId
     */
    async deleteMemory(userId, memoryId) {
        try {
            await this.init()
            return databaseService.deleteMemory(memoryId)
        } catch (e) {
            logger.error(`[MemoryManager] Failed to delete memory ${memoryId}`, e)
            return false
        }
    }

    /**
     * 获取用户所有记忆（别名）
     */
    async getMemories(userId) {
        return this.getAllMemories(userId)
    }

    /**
     * 清空用户所有记忆
     * @param {string} userId
     */
    async clearMemory(userId) {
        try {
            await this.init()
            const count = databaseService.clearMemories(userId)
            logger.debug(`[MemoryManager] 清除 ${userId} 的 ${count} 条记忆`)
            return true
        } catch (e) {
            logger.error(`[MemoryManager] Failed to clear memory for user ${userId}`, e)
            return false
        }
    }

    /**
     * 获取记忆统计
     * @param {string} userId
     */
    async getStats(userId) {
        await this.init()
        return databaseService.getMemoryStats(userId)
    }

    /**
     * 获取所有有记忆的用户
     */
    async listUsers() {
        try {
            await this.init()
            return databaseService.getMemoryUsers().map(u => u.userId)
        } catch (e) {
            logger.error('[MemoryManager] Failed to list users', e)
            return []
        }
    }

    /**
     * 添加记忆（别名）
     */
    async addMemory(userId, content, metadata = {}) {
        return this.saveMemory(userId, content, metadata)
    }

    /**
     * 获取群消息缓冲区中的消息（用于群聊总结）
     * @param {string} groupId - 群ID
     * @returns {Array} 消息列表
     */
    getGroupMessageBuffer(groupId) {
        if (!this.groupMessageBuffer) {
            return []
        }
        return this.groupMessageBuffer.get(groupId) || []
    }

    /**
     * 手动触发用户记忆总结（立即执行覆盖式总结）
     * @param {string} userId - 用户ID
     * @param {{groupId?: string|null}} [options] - 会话作用域
     * @returns {Object} 总结结果
     */
    async summarizeUserMemory(userId, options = {}) {
        if (!config.get('memory.enabled')) {
            return { success: false, error: '记忆功能未启用' }
        }

        try {
            await this.init()

            // 获取现有记忆数量
            const storageUserId = this.getScopedMemoryUserId(userId, options?.groupId)
            const beforeCount = databaseService.getMemories(storageUserId, 100).length

            // 执行覆盖式总结
            const summaryResult = await this.analyzeUserConversations(userId, options)
            if (!summaryResult?.success) {
                return {
                    success: false,
                    userId,
                    beforeCount,
                    afterCount: beforeCount,
                    error: summaryResult?.error || '没有可总结的对话记录',
                    reason: summaryResult?.reason || 'summary_failed'
                }
            }

            // 获取总结后的记忆
            const afterMemories = databaseService.getMemories(storageUserId, 100)

            return {
                success: true,
                userId,
                beforeCount,
                afterCount: afterMemories.length,
                memories: afterMemories.map(m => m.content)
            }
        } catch (error) {
            logger.error(`[MemoryManager] 手动总结失败 [${userId}]:`, error.message)
            return { success: false, error: error.message }
        }
    }

    /**
     * 手动触发群记忆总结
     * @param {string} groupId - 群ID
     * @returns {Object} 总结结果
     */
    async summarizeGroupMemory(groupId) {
        if (!config.get('memory.enabled')) {
            return { success: false, error: '记忆功能未启用' }
        }

        try {
            await this.init()

            // 获取群消息缓冲区
            const messages = this.getGroupMessageBuffer(groupId)

            if (messages.length < 10) {
                return { success: false, error: '群消息记录太少，需要至少10条' }
            }

            // 执行覆盖式总结
            await this.analyzeGroupContext(groupId, messages)

            // 获取总结后的记忆
            const context = await this.getGroupContext(groupId)

            return {
                success: true,
                groupId,
                messageCount: messages.length,
                topics: context.topics?.length || 0,
                relations: context.relations?.length || 0,
                userInfos: context.userInfos?.length || 0
            }
        } catch (error) {
            logger.error(`[MemoryManager] 群记忆总结失败 [${groupId}]:`, error.message)
            return { success: false, error: error.message }
        }
    }

    /**
     * 基于时间段的综合记忆总结
     * 收集指定时间范围内的所有消息和群对话，进行综合总结
     * @param {string} groupId - 群ID
     * @param {Object} options - 配置选项
     * @param {number} options.timeRange - 时间范围（毫秒），默认1小时
     * @param {number} options.minMessages - 最少消息数，默认10
     * @param {string} options.model - 指定使用的模型（可选）
     * @returns {Object} 总结结果
     */
    async summarizeByTimeRange(groupId, options = {}) {
        if (!config.get('memory.enabled')) {
            return { success: false, error: '记忆功能未启用' }
        }

        const {
            timeRange = 60 * 60 * 1000, // 默认1小时
            minMessages = 10,
            model = null
        } = options

        let startApiTime = null
        let channelInfo = null
        let usedModel = null

        try {
            await this.init()

            const now = Date.now()
            const startTime = now - timeRange

            // 1. 从内存缓冲区获取时间范围内的消息
            const bufferMessages = this.getGroupMessageBuffer(groupId) || []
            const recentBufferMessages = bufferMessages.filter(m => m.timestamp >= startTime)

            // 2. 从数据库获取持久化的消息（作为补充）
            const conversationId = `group_summary_${groupId}`
            let dbMessages = []
            try {
                dbMessages = databaseService.getMessages(conversationId, 200) || []
                dbMessages = dbMessages.filter(m => (m.timestamp || 0) >= startTime)
            } catch (e) {
                // 数据库查询失败时继续使用缓冲区消息
            }

            // 3. 合并消息，去重
            const allMessages = [...recentBufferMessages]
            const existingContents = new Set(allMessages.map(m => m.content))

            for (const dbMsg of dbMessages) {
                const content = typeof dbMsg.content === 'string' ? dbMsg.content : dbMsg.content?.text || ''
                if (content && !existingContents.has(content)) {
                    allMessages.push({
                        userId: dbMsg.metadata?.userId || 'unknown',
                        nickname: dbMsg.metadata?.nickname || '未知',
                        content: content,
                        timestamp: dbMsg.timestamp || now
                    })
                    existingContents.add(content)
                }
            }

            // 按时间排序
            allMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))

            if (allMessages.length < minMessages) {
                return {
                    success: false,
                    error: `时间范围内消息不足（${allMessages.length}/${minMessages}）`,
                    messageCount: allMessages.length
                }
            }

            // 4. 获取现有记忆作为上下文
            const existingTopics = databaseService.getMemories(`group:${groupId}:topics`, 10)
            const existingRelations = databaseService.getMemories(`group:${groupId}:relations`, 10)
            const existingUserInfos = databaseService.getMemoriesByPrefix(`group:${groupId}:user:`, 20)

            const existingMemoryText = [
                existingTopics.length > 0 ? `已知话题: ${existingTopics.map(t => t.content).join('; ')}` : '',
                existingRelations.length > 0 ? `已知关系: ${existingRelations.map(r => r.content).join('; ')}` : '',
                existingUserInfos.length > 0 ? `已知用户: ${existingUserInfos.map(u => u.content).join('; ')}` : ''
            ]
                .filter(Boolean)
                .join('\n')

            // 5. 构建对话文本
            const timeRangeMinutes = Math.round(timeRange / 60000)
            const dialogText = allMessages
                .map(m => {
                    const qq = String(m.userId ?? m.user_id ?? m.sender?.user_id ?? '')
                    const name = m.nickname || m.sender?.card || m.sender?.nickname || qq || '未知'
                    return `[${name}${qq ? `(${qq})` : ''}]: ${String(m.content || '').substring(0, 150)}`
                })
                .join('\n')

            // 6. 构建总结提示词：固定指令走 system 命中缓存，数据走 user
            const { system: timeRangeSystem, user: timeRangeUser } = buildGroupMemoryPrompts({
                dialogText,
                existingMemoryText,
                maxItems: 20,
                scopeHint: `过去${timeRangeMinutes}分钟内的${allMessages.length}条群聊消息`
            })

            // 7. 调用LLM进行总结
            startApiTime = Date.now()
            const memoryModel = model || config.get('memory.model')
            const client = await LlmService.getChatClient({ model: memoryModel || undefined })
            channelInfo = client._channelInfo || {}
            usedModel = channelInfo.model || config.get('llm.defaultModel')

            const _temp4 = resolveClientTemperature(client, 0.3)
            const result = await this._sendMemoryLlm(
                client,
                { role: 'user', content: [{ type: 'text', text: timeRangeUser }] },
                {
                    model: usedModel,
                    maxToken: 800,
                    disableHistorySave: true,
                    systemOverride: timeRangeSystem,
                    ...(_temp4 !== undefined ? { temperature: _temp4 } : {})
                },
                'MemoryTimeRange'
            )

            const responseText = result.contents?.[0]?.text?.trim() || ''

            // 记录统计
            try {
                await statsService.recordApiCall({
                    channelId: channelInfo.id || 'memory',
                    channelName: channelInfo.name || '记忆服务',
                    model: usedModel,
                    reportedModel: result.model || null,
                    duration: Date.now() - startApiTime,
                    success: typeof responseText === 'string' && responseText.length > 0,
                    source: '时间段记忆总结',
                    groupId,
                    responseText,
                    apiUsage: result.usage,
                    request: { model: usedModel, timeRange: timeRangeMinutes }
                })
            } catch (e) {
                /* 统计失败不影响主流程 */
            }

            if (!responseText || responseText === '无' || responseText.length < 10) {
                return {
                    success: true,
                    groupId,
                    messageCount: allMessages.length,
                    timeRangeMinutes,
                    result: '无新的有效信息'
                }
            }

            // 8. 解析并保存记忆
            const jsonLines = this._jsonToMemoryLines(responseText)
            const lines = jsonLines || responseText.split('\n').filter(line => line.trim())
            const newTopics = []
            const newRelations = []
            const newUserInfos = new Map()

            for (const line of lines) {
                if (this._isInvalidMemoryLine(line)) continue

                const userMatch = line.match(/【用户[:：](.+?)】(.+)/)
                if (userMatch) {
                    const nickname = userMatch[1].trim()
                    const info = userMatch[2].trim()
                    if (info.length > 3 && info.length < 100) {
                        const existing = newUserInfos.get(nickname) || []
                        existing.push(info)
                        newUserInfos.set(nickname, existing)
                    }
                    continue
                }

                const topicMatch = line.match(/【话题】(.+)/)
                if (topicMatch) {
                    const topic = topicMatch[1].trim()
                    if (topic.length > 3 && topic.length < 100) {
                        if (!this._isJunkMemoryLine(topic)) newTopics.push(topic)
                    }
                    continue
                }

                const relationMatch = line.match(/【关系】(.+)/)
                if (relationMatch) {
                    const relation = relationMatch[1].trim()
                    if (relation.length > 3 && relation.length < 100) {
                        if (!this._isJunkMemoryLine(relation)) newRelations.push(relation)
                    }
                }
            }

            // 9. 覆盖式保存记忆（清空 + 写入在同一事务内，避免中途失败丢失旧记忆）
            if (newTopics.length > 0) {
                databaseService.replaceMemories(
                    `group:${groupId}:topics`,
                    newTopics.slice(0, 10).map(topic => ({ content: topic, source: 'time_range_summary' }))
                )
            }

            if (newRelations.length > 0) {
                databaseService.replaceMemories(
                    `group:${groupId}:relations`,
                    newRelations.slice(0, 10).map(relation => ({ content: relation, source: 'time_range_summary' }))
                )
            }

            if (newUserInfos.size > 0) {
                for (const [nickname, infos] of newUserInfos) {
                    databaseService.replaceMemories(
                        `group:${groupId}:user:${nickname}`,
                        infos.slice(0, 3).map(info => ({ content: info, source: 'time_range_summary' }))
                    )
                }
            }

            // 记录本次总结时间
            this.lastSummarizeTime.set(groupId, now)
            this._capTimeMap(this.lastSummarizeTime)

            logger.info(
                `[MemoryManager] 群 ${groupId} 时间段总结完成: 消息${allMessages.length}条, 话题${newTopics.length}, 关系${newRelations.length}, 用户${newUserInfos.size}`
            )

            return {
                success: true,
                groupId,
                messageCount: allMessages.length,
                timeRangeMinutes,
                topics: newTopics.length,
                relations: newRelations.length,
                userInfos: newUserInfos.size,
                model: usedModel
            }
        } catch (error) {
            logger.error(`[MemoryManager] 时间段总结失败 [${groupId}]:`, error.message)
            try {
                await statsService.recordApiCall({
                    channelId: channelInfo?.id || 'memory',
                    channelName: channelInfo?.name || '记忆服务',
                    model: usedModel || config.get('llm.defaultModel'),
                    duration: startApiTime ? Date.now() - startApiTime : 0,
                    success: false,
                    error: error.message || String(error),
                    source: '时间段记忆总结',
                    groupId
                })
            } catch (e) {
                /* 统计失败不影响主流程 */
            }
            return { success: false, error: error.message }
        }
    }

    /**
     * 搜索群聊记忆
     * @param {string} groupId - 群ID
     * @param {string} query - 搜索关键词
     * @param {Object} options - 选项
     * @returns {Object} 搜索结果
     */
    async searchGroupMemory(groupId, query, options = {}) {
        await this.init()
        const { limit = 10, type = 'all' } = options

        const results = {
            topics: [],
            relations: [],
            userInfos: [],
            total: 0
        }

        try {
            // 搜索话题
            if (type === 'all' || type === 'topics') {
                const topicKey = `group:${groupId}:topics`
                const topics = databaseService.searchMemories(topicKey, query, limit)
                results.topics = topics.map(t => t.content)
            }

            // 搜索关系
            if (type === 'all' || type === 'relations') {
                const relationKey = `group:${groupId}:relations`
                const relations = databaseService.searchMemories(relationKey, query, limit)
                results.relations = relations.map(r => r.content)
            }

            // 搜索用户信息
            if (type === 'all' || type === 'users') {
                const userInfos = databaseService.getMemoriesByPrefix(`group:${groupId}:user:`, 50)
                const matchedUsers = userInfos.filter(
                    u =>
                        u.content?.toLowerCase().includes(query.toLowerCase()) ||
                        u.userId?.toLowerCase().includes(query.toLowerCase())
                )
                results.userInfos = matchedUsers.slice(0, limit).map(u => ({
                    user: u.userId?.replace(`group:${groupId}:user:`, ''),
                    content: u.content
                }))
            }

            results.total = results.topics.length + results.relations.length + results.userInfos.length

            logger.debug(`[MemoryManager] 群 ${groupId} 搜索 "${query}": 找到 ${results.total} 条结果`)
            return results
        } catch (error) {
            logger.error(`[MemoryManager] 搜索群记忆失败:`, error.message)
            return results
        }
    }

    /**
     * 获取群内所有用户的记忆摘要
     * @param {string} groupId - 群ID
     * @returns {Array} 用户记忆列表
     */
    async getGroupUsersSummary(groupId) {
        await this.init()

        try {
            const userInfos = databaseService.getMemoriesByPrefix(`group:${groupId}:user:`, 100)

            // 按用户分组
            const userMap = new Map()
            for (const info of userInfos) {
                const user = info.userId?.replace(`group:${groupId}:user:`, '') || 'unknown'
                if (!userMap.has(user)) {
                    userMap.set(user, [])
                }
                userMap.get(user).push(info.content)
            }

            // 转换为数组
            const result = []
            for (const [user, memories] of userMap) {
                result.push({
                    user,
                    memories,
                    count: memories.length
                })
            }

            return result.sort((a, b) => b.count - a.count)
        } catch (error) {
            logger.error(`[MemoryManager] 获取群用户摘要失败:`, error.message)
            return []
        }
    }

    /**
     * 列出所有有记忆的群
     * @returns {Array} 群ID列表
     */
    async listGroups() {
        await this.init()

        try {
            const allMemories = databaseService.getMemoriesByPrefix('group:', 1000)
            const groupIds = new Set()

            for (const m of allMemories) {
                const match = m.userId?.match(/^group:(\d+)/)
                if (match) {
                    groupIds.add(match[1])
                }
            }

            return Array.from(groupIds)
        } catch (error) {
            logger.error(`[MemoryManager] 列出群失败:`, error.message)
            return []
        }
    }

    /**
     * 清除群的所有记忆
     * @param {string} groupId - 群ID
     * @returns {Object} 清除结果
     */
    async clearGroupMemory(groupId) {
        await this.init()

        try {
            let cleared = 0

            // 清除话题
            cleared += databaseService.clearMemories(`group:${groupId}:topics`)

            // 清除关系
            cleared += databaseService.clearMemories(`group:${groupId}:relations`)

            // 清除用户信息
            const userInfos = databaseService.getMemoriesByPrefix(`group:${groupId}:user:`, 100)
            for (const info of userInfos) {
                databaseService.deleteMemory(info.id)
                cleared++
            }

            // 清除消息缓冲区
            if (this.groupMessageBuffer) {
                this.groupMessageBuffer.delete(groupId)
            }

            logger.info(`[MemoryManager] 清除群 ${groupId} 的 ${cleared} 条记忆`)
            return { success: true, cleared }
        } catch (error) {
            logger.error(`[MemoryManager] 清除群记忆失败:`, error.message)
            return { success: false, error: error.message }
        }
    }
}

export const memoryManager = new MemoryManager()
