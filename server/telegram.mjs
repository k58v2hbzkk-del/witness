// Optional Telegram companion. Set TELEGRAM_BOT_TOKEN (from @BotFather) to turn it on.
// Your glasses stay the place you act; Telegram is your receipt book and your status check.

const API = 'https://api.telegram.org'

export class Telegram {
  constructor(token, { onCommand, log = () => {}, chats = [] } = {}) {
    this.token = token
    this.onCommand = onCommand
    this.log = log
    this.chats = new Set(chats)
    this.offset = 0
    this.code = Math.random().toString(36).slice(2, 8).toUpperCase()
    this.username = null
  }
  get enabled() {
    return Boolean(this.token)
  }
  async call(method, body) {
    const r = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(35_000),
    })
    const j = await r.json()
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description}`)
    return j.result
  }
  async start() {
    if (!this.enabled) return
    try {
      this.username = (await this.call('getMe')).username
      this.log(`telegram bot @${this.username} ready, link code ${this.code}`)
    } catch (e) {
      this.log('telegram disabled: ' + e.message)
      this.token = null
      return
    }
    this.poll()
  }
  async poll() {
    while (this.token) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message'] })
        for (const u of updates) {
          this.offset = u.update_id + 1
          await this.handle(u.message)
        }
      } catch (e) {
        this.log('telegram poll: ' + e.message)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }
  async handle(msg) {
    if (!msg?.text) return
    const chat = msg.chat.id
    const [cmd, arg] = msg.text.trim().split(/\s+/)
    if (cmd === '/start') {
      if (arg && arg.toUpperCase() === this.code) {
        this.chats.add(chat)
        this.onCommand?.('linked', chat)
        return this.send(chat, 'Linked. Your Witness receipts will land here.\n/status shows your paper account.')
      }
      return this.send(chat, 'Send /start followed by the code shown in the Witness phone app.')
    }
    if (!this.chats.has(chat)) return this.send(chat, 'Not linked yet. Send /start CODE from the Witness phone app.')
    const reply = this.onCommand?.(cmd.replace('/', ''), chat)
    if (reply) return this.send(chat, reply)
  }
  send(chat, text) {
    return this.call('sendMessage', { chat_id: chat, text, disable_web_page_preview: true }).catch((e) => this.log(e.message))
  }
  broadcast(text) {
    for (const c of this.chats) this.send(c, text)
  }
}
