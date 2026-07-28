// notify.js — push new roles to Telegram. Free and instant.
// Create a bot with @BotFather, get your chat id from @userinfobot,
// then set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.

export async function notifyTelegram(jobs) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat || jobs.length === 0) return;

  // Cap the number of individual pings so a big sweep can't flood your phone;
  // the rest still land in the feed/dashboard. Batch into ~8 per message.
  const MAX = 12;
  const show = jobs.slice(0, MAX);
  const more = jobs.length - show.length;

  for (let i = 0; i < show.length; i += 8) {
    const batch = show.slice(i, i + 8);
    const lines = batch.map(j => {
      const bits = [esc(j.category)];
      if (j.pay) bits.push(esc(j.pay));
      if (j.employment) bits.push(esc(j.employment));
      if (j.byod) bits.push("⚙ BYOD");
      else if (j.maybeHybrid) bits.push("⚠️ maybe hybrid");
      return `🟡 <b>${esc(j.title)}</b>\n${esc(j.agency)} · ${bits.join(" · ")}\n<a href="${j.url}">Open posting</a>`;
    });
    const header = `<b>${jobs.length} new remote role${jobs.length > 1 ? "s" : ""} on the radar</b>`;
    const footer = (i + 8 >= show.length && more > 0) ? `\n\n➕ +${more} more — see the dashboard` : "";
    const text = `${header}\n\n${lines.join("\n\n")}${footer}`;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    }).catch(() => {});
  }
}

const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
