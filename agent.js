require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const Parser = require('rss-parser');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const parser = new Parser();
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

// URL of your deployed feedback page (set after Vercel deploy)
const FEEDBACK_URL = process.env.FEEDBACK_URL || 'https://example.vercel.app';

// How strongly feedback steers the digest: 'gentle' or 'strong'
// Start with 'gentle', switch to 'strong' once you've seen how it behaves.
const FEEDBACK_MODE = 'gentle';

// How many days of past stories to remember (avoid repeats)
const MEMORY_DAYS = 7;

// ============================================
// DO NOT EDIT BELOW THIS LINE
// ============================================

function isRecent(pubDate) {
  if (!pubDate) return false;
  const articleDate = new Date(pubDate);
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);
  return articleDate >= oneDayAgo;
}

function fingerprint(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .join(' ');
}

// Deduplicate articles within today's batch
function deduplicateArticles(articles) {
  const seen = new Set();
  const result = [];
  for (const article of articles) {
    const fp = fingerprint(article.title);
    if (!seen.has(fp)) {
      seen.add(fp);
      result.push(article);
    }
  }
  return result;
}

// MEMORY: read titles we've already sent in the last N days
async function getRecentSentTitles() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MEMORY_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  try {
    const { data, error } = await supabase
      .from('sent_articles')
      .select('title')
      .gte('sent_date', cutoffStr);

    if (error) {
      console.log('⚠️ Could not read memory:', error.message);
      return [];
    }
    return (data || []).map(row => row.title);
  } catch (err) {
    console.log('⚠️ Memory read failed:', err.message);
    return [];
  }
}

// FEEDBACK: read recent feedback and build a guidance string for the prompt
async function getFeedbackGuidance() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  try {
    const { data, error } = await supabase
      .from('feedback')
      .select('country, topic, rating, too_vague')
      .gte('created_at', cutoff.toISOString());

    if (error || !data || data.length === 0) {
      return ''; // no feedback yet
    }

    const liked = {};
    const disliked = {};
    let vagueCount = 0;

    for (const row of data) {
      const key = row.country || row.topic || 'unknown';
      if (row.rating === 'up') liked[key] = (liked[key] || 0) + 1;
      if (row.rating === 'down') disliked[key] = (disliked[key] || 0) + 1;
      if (row.too_vague) vagueCount++;
    }

    const topLiked = Object.entries(liked).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
    const topDisliked = Object.entries(disliked).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);

    const strength = FEEDBACK_MODE === 'strong'
      ? 'This is a STRONG preference - weight it heavily in your selection.'
      : 'This is a gentle preference - use it as a tiebreaker, not a hard rule.';

    let guidance = '\n\nREADER FEEDBACK (learned from past ratings):\n';
    if (topLiked.length) guidance += `- The reader tends to like stories about: ${topLiked.join(', ')}. Favour these. ${strength}\n`;
    if (topDisliked.length) guidance += `- The reader tends to dislike stories about: ${topDisliked.join(', ')}. Include fewer of these. ${strength}\n`;
    if (vagueCount >= 2) guidance += `- The reader has flagged some past stories as TOO VAGUE. Be extra specific: always include hard numbers, named parties, and concrete second-order effects.\n`;

    return guidance;
  } catch (err) {
    console.log('⚠️ Feedback read failed:', err.message);
    return '';
  }
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

async function fetchHeadlines(sentTitles) {
  const feeds = buildFeeds();
  const articles = [];
  const sentFingerprints = new Set(sentTitles.map(fingerprint));

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

  // Drop today's internal duplicates
  let deduplicated = deduplicateArticles(articles);

  // MEMORY: drop anything we've already sent recently
  const beforeMemory = deduplicated.length;
  deduplicated = deduplicated.filter(a => !sentFingerprints.has(fingerprint(a.title)));

  console.log(`✅ ${articles.length} fetched, ${beforeMemory} after dedup, ${deduplicated.length} after memory filter\n`);
  return deduplicated;
}

function articlesToText(articles) {
  return articles.map((a, i) =>
    `[${i+1}] TITLE: ${a.title}\nDATE: ${a.date}\nURL: ${a.url}\nTOPIC: ${a.topic}`
  ).join('\n\n');
}

// Parse Claude's output to extract the stories it actually used (for memory)
function parseSentStories(digestText) {
  const stories = [];
  const lines = digestText.split('\n');

  for (const line of lines) {
    let raw = null;
    if (line.startsWith('📌')) raw = line.replace('📌', '').trim();
    else if (line.startsWith('•')) {
      raw = line.replace('•', '').replace(/🔗 https?:\/\/[^\s]+/, '').trim();
    }
    if (!raw) continue;

    // Format is "[Country]: [title]"
    const colonIndex = raw.indexOf(':');
    let country = null;
    let title = raw;
    if (colonIndex > 0 && colonIndex < 25) {
      country = raw.slice(0, colonIndex).trim();
      title = raw.slice(colonIndex + 1).trim();
    }
    stories.push({ title, country });
  }
  return stories;
}

// Save today's stories to memory
async function saveSentStories(stories) {
  if (!stories.length) return;
  const rows = stories.map(s => ({
    title: s.title,
    country: s.country,
    sent_date: new Date().toISOString().split('T')[0],
  }));

  try {
    const { error } = await supabase.from('sent_articles').insert(rows);
    if (error) console.log('⚠️ Could not save memory:', error.message);
    else console.log(`💾 Saved ${rows.length} stories to memory`);
  } catch (err) {
    console.log('⚠️ Memory save failed:', err.message);
  }
}

function formatEmail(text, date, articles) {
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
        <div style="text-align:center;margin:28px 0 8px;">
          <a href="${FEEDBACK_URL}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 20px;border-radius:6px;">Rate today's digest →</a>
          <p style="margin:8px 0 0;font-size:11px;color:#94a3b8;">Your ratings help sharpen tomorrow's digest</p>
        </div>
      </div>
    </div>
  `;
}

async function runAgent() {
  console.log('🤖 Agent starting...\n');

  // Read memory + feedback before fetching
  const sentTitles = await getRecentSentTitles();
  console.log(`🧠 Remembering ${sentTitles.length} recently sent stories`);
  const feedbackGuidance = await getFeedbackGuidance();
  if (feedbackGuidance) console.log('📊 Applying reader feedback');

  const articles = await fetchHeadlines(sentTitles);
  console.log('📤 Sending to Claude...\n');

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 6000,
    messages: [{
      role: 'user',
      content: `You are a news monitoring agent for a senior fintech professional (Head of Merchant Payments) working across the SADC region. They want sharp, specific, decision-useful intelligence - not generic summaries.

Here are recent articles (last 24 hours only):
${articlesToText(articles)}
${feedbackGuidance}
SELECTION RULES:
- Select exactly 5 stories for Section 1 and exactly 5 stories for Section 2. Total: 10, no duplicates.
- Some articles describe the SAME real-world event with different headlines (e.g. one names the company, another describes the deal size or sector). Treat these as duplicates and pick only ONE. For example "R12-billion fintech makes acquisition" and "Yoco acquires AI startup" may be the same event.
- A story used in Section 1 (Top Stories) must NOT also appear in Section 2 (Quick Hits). Each event appears ONCE in the whole digest, in one section only.
- Each story's News and Impact text must be unique. Never repeat the same paragraph across two stories.
- Avoid same-theme clustering: do not pick two M&A stories, two rate-hike stories, or two of the same topic.
- Write in English, unless the source article is clearly in French.
- Keep the exact URLs from the articles above.
- Priority markets: South Africa, Zimbabwe, France, Europe get 3-4 stories total. Botswana, Malawi, Zambia, Tanzania, Mozambique share 1-2 only if genuinely significant.
- Do NOT output a digest header line at the top.

SHARPNESS RULES (critical - this is what makes the digest valuable). Keep the three sections DISTINCT - they must not overlap or repeat each other:
- CONTEXT (1 sentence): ONLY the macro backdrop of the country or sector - the broader market or regulatory trend this sits within. Do NOT describe the specific company or the news event here; that belongs in News.
- NEWS (1-2 sentences): ONLY what is happening - the facts. Name the specific company, the exact amount (R-value, $-value, %), the named parties, and the date. No analysis here.
- IMPACT (exactly 2 sentences, no more): Sentence 1 - what this SIGNALS about the market. Sentence 2 - what is likely to FOLLOW next (who reacts, second-order effect). Be concise. Do NOT repeat facts already stated in News.
- Each Top Story title must include the country and be specific. Format: [Country]: [Specific punchy title with names/numbers where possible]
- Quick Hits (1 sentence each): lead with the country, name the company and the key number. Format: [Country]: [Specific punchy sentence]
- KEY TAKEAWAY: one sharp sentence naming the single most important pattern across today's stories. Must reference specifics, not "consolidation is happening".

Format EXACTLY like this:

💡 KEY TAKEAWAY
[One sharp specific sentence with names/specifics]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▋SECTION 1 — TOP STORIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

═══════════════════════════════════

📌 [Country]: [Specific punchy title]
📅 [Date]  |  🔗 [URL]

🌍 Context
[Macro backdrop of country/sector only]

📰 News
[The facts: company, amount, parties, date]

⚡ Impact
[What it signals + what follows - 2 sentences]

───────────────────────────────────

▋SECTION 2 — QUICK HITS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• [Country]: [Specific punchy sentence]  🔗 [URL]

───────────────────────────────────`
    }]
  });

  const digestText = message.content[0].text;
  console.log(digestText);

  // Save what we sent, so we don't repeat it
  const sentStories = parseSentStories(digestText);
  await saveSentStories(sentStories);

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