// notify.js — push new roles to Telegram. Free and instant.
// Create a bot with @BotFather, get your chat id from @userinfobot,
// then set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.

export async function notifyTelegram(jobs) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat || jobs.length === 0) return;

  // Batch into messages of ~8 roles to stay under Telegram's length limit.
  for (let i = 0; i < jobs.length; i += 8) {
    const batch = jobs.slice(i, i + 8);
    const lines = batch.map(j =>
      `🟡 <b>${esc(j.title)}</b>\n${esc(j.agency)} · ${esc(j.category)}${j.maybeHybrid ? " · ⚠️ maybe hybrid" : ""}\n<a href="${j.url}">Open posting</a>`
    );
    const text = `<b>${jobs.length} new remote role${jobs.length > 1 ? "s" : ""} on the radar</b>\n\n${lines.join("\n\n")}`;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    }).catch(() => {});
  }
}

const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
