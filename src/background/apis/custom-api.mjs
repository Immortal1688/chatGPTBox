// custom api version

// There is a lot of duplicated code here, but it is very easy to refactor.
// The current state is mainly convenient for making targeted changes at any time,
// and it has not yet had a negative impact on maintenance.
// If necessary, I will refactor.

import { getUserConfig, maxResponseTokenLength } from '../../config/index.mjs'
import { fetchSSE } from '../../utils/fetch-sse'
import { getConversationPairs } from '../../utils/get-conversation-pairs'
import { isEmpty } from 'lodash-es'
import { pushRecord } from './shared.mjs'

const getCustomApiPromptBase = async () => {
  return `I am a helpful, creative, clever, and very friendly assistant. I am familiar with various languages in the world.`
}

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} apiKey
 * @param {string} modelName
 */
export async function generateAnswersWithCustomApi(port, question, session, apiKey, modelName) {
  const controller = new AbortController()
  const stopListener = (msg) => {
    if (msg.stop) {
      console.debug('stop generating')
      port.postMessage({ done: true })
      port.onMessage.removeListener(stopListener)
      controller.abort()
    }
  }
  port.onMessage.addListener(stopListener)
  port.onDisconnect.addListener(() => {
    console.debug('port disconnected')
    controller.abort()
  })

  const prompt = getConversationPairs(session.conversationRecords, true)
  prompt.unshift({ role: 'system', content: await getCustomApiPromptBase() })
  prompt.push({ role: 'user', content: question })
  const apiUrl = (await getUserConfig()).customModelApiUrl

  let answer = ''
  await fetchSSE(apiUrl, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      messages: prompt,
      model: modelName,
      stream: true,
      max_tokens: maxResponseTokenLength,
    }),
    onMessage(message) {
      console.debug('sse message', message)
      if (message === '[DONE]') {
        pushRecord(session, question, answer)
        console.debug('conversation history', { content: session.conversationRecords })
        port.postMessage({ answer: null, done: true, session: session })
        return
      }
      let data
      try {
        data = JSON.parse(message)
      } catch (error) {
        console.debug('json error', error)
        return
      }
      if (data.response) answer = data.response
      port.postMessage({ answer: answer, done: false, session: null })
    },
    async onStart() {},
    async onEnd() {
      port.onMessage.removeListener(stopListener)
    },
    async onError(resp) {
      port.onMessage.removeListener(stopListener)
      if (resp instanceof Error) throw resp
      if (resp.status === 403) {
        throw new Error('CLOUDFLARE')
      }
      const error = await resp.json().catch(() => ({}))
      throw new Error(!isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`)
    },
  })
}
