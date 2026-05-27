require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const Parser = require('rss-parser');
const { Resend } = require('resend');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const parser = new Parser();
const resend = new Resend(process.env.RESEND_API_KEY);

// ============================================
// 👇 ONLY EDIT THIS SECTION
// ============================================

const COUNTRIES = [
  'South Africa',
  'Zimbabwe',
  'Zambia',
  'Mozambique',
  'Tanzania',
  'Malawi',
  'France',
  'Europe',
];

const TOPICS = [
  'fintech',
  'mobile money',
  'payment',
  'banking',
  'merchant banking',
  'SME banking',
  'fintech startup',
  'AI banking',
  'AI payments',
];

const EMAIL_TO   = 'timothee.dura@gmail.com';
const EMAIL_FROM = 'onboarding@resend.dev';

// ============================================
// DO NOT EDIT BELOW THIS LINE
// ============================================

function isRecent(pubDate) {
  if (!pubDate) return false;
  const articleDate = new Date(pubDate);
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  return articleDate >= threeDaysAgo;
}

function buildFeeds() {
  const feeds = [];
  for (const country of COUNTRIES) {
    for (const topic of TOPICS) {
      const query = encodeURIComponent(`${topic} ${country}`);
      feeds.push({
        name: `${topic} – ${country}`,
        url: `https://news.google.com/rss/search?q=${query}&hl=en&gl=ZA&ceid=ZA:en`
      });
    }
  }
  return feeds;
}

async function fetchHeadlines() {
  const feeds = buildFeeds();
  const articles = [];

  for (const feed of feeds) {
    try {
      const result = await parser.parseURL(feed.url);
      const recentItems = result.items.filter(item => isRecent(item.pubDate));
      recentItems.slice(0, 2).forEach(item => {
        articles.push({
          title: item.title,
          date: item.pubDate || 'N/A',
          url: item.link,
          topic: feed.name,
        });
      });
    } catch (err) {
      console.log(`⚠️ Error: ${feed.name}`);
    }
  }

  console.log(`✅ ${articles.length} recent articles found\n`);
  return articles;
}

function articlesToText(articles) {
  return articles.map((a, i) =>
    `[${i+1}] TITLE: ${a.title}\nDATE: ${a.date}\nURL: ${a.url}\nTOPIC: ${a.topic}`
  ).join('\n\n');
}

function formatEmail(text, date, articles) {
  const urlMap = {};
  articles.forEach(a => { urlMap[a.title] = a.url; });

  const lines = text.split('\n');
  let html = '';
  let inKeyTakeaway = false;

  for (const line of lines) {
    if (line.match(/^━+$/)) {
      html += '<hr style="border:none;border-top:1px solid #e2e8f0;margin:6px 0;">';
    } else if (line.match(/^═+$/)) {
      html += '<hr style="border:none;border-top:1px solid #f1f5f9;margin:4px 0;">';
    } else if (line.match(/^─+$/)) {
      html += '<hr style="border:none;border-top:1px solid #f8fafc;margin:4px 0;">';
    } else if (line.includes('SECTION 1') || line.includes('TOP STORIES')) {
      html += `<h2 style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;margin:16px 0 4px;">Section 1 — Top Stories</h2>`;
    } else if (line.includes('SECTION 2') || line.includes('QUICK HITS')) {
      html += `<h2 style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;margin:24px 0 4px;">Section 2 — Quick Hits</h2>`;
    } else if (line.includes('KEY TAKEAWAY')) {
      inKeyTakeaway = true;
      html += `<div style="background:#f0fdf4;border-left:3px solid #22c55e;padding:12px 16px;margin:0 0 20px 0;border-radius:0 6px 6px 0;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#16a34a;letter-spacing:1px;">💡 KEY TAKEAWAY</p>`;
    } else if (inKeyTakeaway && line.trim() !== '') {
      html += `<p style="margin:0;font-size:14px;color:#166534;line-height:1.5;">${line}</p></div>`;
      inKeyTakeaway = false;
    } else if (line.startsWith('📌')) {
      html += `<h3 style="font-size:15px;font-weight:700;color:#0f172a;margin:4px 0 4px;line-height:1.4;">${line}</h3>`;
    } else if (line.startsWith('📅')) {
      const urlMatch = line.match(/🔗 (https?:\/\/[^\s]+)/);
      const datePart = line.split('|')[0].replace('📅', '').trim();
      const url = urlMatch ? urlMatch[1] : null;
      html += `<p style="margin:0 0 8px;font-size:12px;color:#94a3b8;">
        📅 ${datePart}
        ${url ? `&nbsp;·&nbsp;<a href="${url}" style="color:#3b82f6;text-decoration:none;font-weight:600;">Read more →</a>` : ''}
      </p>`;
    } else if (line.startsWith('🌍')) {
      html += `<p style="font-size:12px;font-weight:600;color:#475569;margin:8px 0 0;">🌍 Context</p>`;
    } else if (line.startsWith('📰')) {
      html += `<p style="font-size:12px;font-weight:600;color:#475569;margin:8px 0 0;">📰 News</p>`;
    } else if (line.startsWith('⚡')) {
      html += `<p style="font-size:12px;font-weight:600;color:#475569;margin:8px 0 0;">⚡ Impact</p>`;
    } else if (line.startsWith('•')) {
      const urlMatch = line.match(/🔗 (https?:\/\/[^\s]+)/);
      const textPart = line.replace(/🔗 https?:\/\/[^\s]+/, '').replace('•', '').trim();
      const url = urlMatch ? urlMatch[1] : null;
      html += `<div style="padding:8px 0;border-bottom:1px solid #f1f5f9;">
        <p style="margin:0 0 3px;font-size:13px;color:#1e293b;line-height:1.4;">${textPart}</p>
        ${url ? `<a href="${url}" style="font-size:11px;color:#3b82f6;text-decoration:none;font-weight:600;">Read more →</a>` : ''}
      </div>`;
    } else if (line.trim() === '') {
      // no extra space
    } else {
      html += `<p style="margin:0 0 4px;font-size:13px;color:#334155;line-height:1.6;">${line}</p>`;
    }
  }

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:620px;margin:auto;background:#ffffff;">
      <div style="background:#0f172a;padding:24px 28px;border-radius:10px 10px 0 0;">
        <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:2px;color:#475569;text-transform:uppercase;">SADC Fintech Intelligence</p>
        <h1 style="margin:6px 0 4px;font-size:22px;font-weight:800;color:#ffffff;">Daily Digest</h1>
        <p style="margin:0;font-size:12px;color:#64748b;">${date}</p>
      </div>
      <div style="padding:20px 28px;background:#ffffff;">
        ${html}
      </div>
    </div>
  `;
}

async function runAgent() {
  console.log('🤖 Agent starting...\n');
  const articles = await fetchHeadlines();
  console.log('📤 Sending to Claude...\n');

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 6000,
    messages: [{
      role: 'user',
      content: `You are a news monitoring agent for a senior fintech professional working across the SADC region.

Here are recent articles (last 3 days):
${articlesToText(articles)}

Instructions:
- Select exactly 5 stories for Section 1 and exactly 5 stories for Section 2. Total: 10 stories, no duplicates.
- Each story must be DIFFERENT. Do not repeat any story or URL.
- Write in English, unless the source article is clearly in French.
- Keep the exact URLs from the articles above in your output.
- Priority markets: South Africa, Zimbabwe, France, Europe get 3-4 stories total. Botswana, Malawi, Zambia, Tanzania, Mozambique share 1-2 stories total only if genuinely significant.
- Do NOT output a digest header line at the top.
- Each Top Story title must include the country. Format: [Country]: [Punchy title]
- Each Quick Hit must start with the country. Format: [Country]: [One punchy sentence]
- KEY TAKEAWAY must be one sharp specific sentence summarising the most important pattern from today's stories. It must not be empty.
- Context: 1 sentence max. News: 2 sentences max. Impact: 3 sentences max. Be concise.

Format EXACTLY like this:

💡 KEY TAKEAWAY
[One sharp specific sentence]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▋SECTION 1 — TOP STORIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

═══════════════════════════════════

📌 [Country]: [Punchy title]
📅 [Date]  |  🔗 [URL]

🌍 Context
[1 sentence]

📰 News
[2 sentences]

⚡ Impact
[3 sentences]

───────────────────────────────────

▋SECTION 2 — QUICK HITS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• [Country]: [One punchy sentence]  🔗 [URL]

───────────────────────────────────`
    }]
  });

  const digestText = message.content[0].text;
  console.log(digestText);

  console.log('\n📧 Sending email...');
  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: `📋 SADC Fintech Digest — ${today}`,
    html: formatEmail(digestText, today, articles),
  });

  if (error) {
    console.error('❌ Email error:', error);
  } else {
    console.log('✅ Email sent!', data);
  }
}

runAgent();