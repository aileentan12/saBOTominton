const { Client, GatewayIntentBits, Partials } = require('discord.js');
const cron = require('node-cron');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// CHANNEL CONFIG
const SOURCE_CHANNEL_ID = process.env.SOURCE_CHANNEL_ID; // read from
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID; // commands + send

const BOT_TOKEN = process.env.BOT_TOKEN;

// Tracks ongoing command sessions
const activeSessions = {};

// ─── HELPERS ─────────────────────────────────────────

function getNextSaturday() {
  const now = new Date();
  const phtParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short',
  }).formatToParts(now);

  const weekday = phtParts.find(p => p.type === 'weekday').value;
  const month = parseInt(phtParts.find(p => p.type === 'month').value) - 1;
  const day = parseInt(phtParts.find(p => p.type === 'day').value);
  const year = parseInt(phtParts.find(p => p.type === 'year').value);

  const dayIndex = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(weekday);
  const daysUntilSat = dayIndex === 6 ? 7 : (6 - dayIndex);

  return new Date(year, month, day + daysUntilSat);
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function resolveVenue(venueAndCourts) {
  let venue = 'TBA';
  let courts = venueAndCourts.trim();

  if (/annex/i.test(venueAndCourts)) {
    venue = 'CCF Annex Gym 20th Floor';
    courts = venueAndCourts.replace(/annex\s*/i, '').trim();
  } else if (/goodminton|\bgm\b/i.test(venueAndCourts)) {
    venue = 'Goodminton Smash Zone';
    courts = venueAndCourts.replace(/goodminton\s*/i, '').replace(/\bgm\b\s*/i, '').trim();
  }
  return { venue, courts };
}

// ─── VOLUNTEERS ─────────────────────────────────────

const VOLUNTEER_NAMES = {
  'arvin':  'Arvin Cruz - Adv',
  'adrian': 'Adrian Villaflor - Int',
  'jerby':  'Jerby Lopez - Int',
  'j':      'Jerby Lopez - Int',
  'romeo':  'Romeo Buban - Adv',
  'daddy':  'Romeo Buban - Adv',
  'dad':    'Romeo Buban - Adv',
  'denise': 'Denise Regulto - Int',
  'athena': 'Athena Regulto - Int',
  'hope':   'Hope Agudo - Int',
  'marvin': 'Marvin Despi - Adv',
  'migs':   'Christian "Migs" Miguel - Int',
  'mrmr':   'Mira Rofuli - Int',
  'mira':   'Mira Rofuli - Int',
  'ponj':   'Raul Roco - Int',
  'raul':   'Raul Roco - Int',
  'aileen': 'Aileen Tan - Int',
  'gerry':  'Gerry Matias - Int',
  'tim':    'Tim Macawili - Adv',
  'vic':    'Vic Garfin - Int',
};

function resolveVolunteerName(raw) {
  const cleaned = raw.replace(/\s*-?\s*(paid|pd)\b/gi, '').replace(/\s*\(tentative\)/i, '').trim();
  return VOLUNTEER_NAMES[cleaned.toLowerCase()] || cleaned;
}

function isPaid(text) {
  return /\b(paid|pd)\b|\(paid\)/i.test(text);
}

function isVolunteer(text) {
  return text.trim().startsWith('*');
}

// ─── READ SOURCE CHANNEL ────────────────────────────

async function getVolunteersForDate(channel, targetDate) {
  const messages = await channel.messages.fetch({ limit: 50 });

  const monthLong = targetDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Manila' });
  const monthShort = targetDate.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Manila' });
  const day = targetDate.getDate();
  const dayPadded = String(day).padStart(2, '0');

  const datePatterns = [
    `${monthLong} ${day}`,
    `${monthLong} ${dayPadded}`,
    `${monthShort} ${day}`,
    `${monthShort} ${dayPadded}`,
  ];

  let sessionBlock = null;
  let sessionTime = '';
  let sessionVenue = '';

  for (const [, msg] of messages) {
    if (msg.author.bot) continue;
    const content = msg.content;

    if (!datePatterns.some(p => content.includes(p))) continue;

    const headerRegex = /\*{0,2}([A-Za-z]+ \d+\s*\([^)]+\))\*{0,2}/g;
    const headers = [...content.matchAll(headerRegex)];

    for (let i = 0; i < headers.length; i++) {
      const headerText = headers[i][1].trim();
      if (!datePatterns.some(p => headerText.startsWith(p))) continue;

      const timeMatch = headerText.match(/\(([^)]+)\)/);
      if (timeMatch) {
        const parts = timeMatch[1].split(',');
        sessionTime = parts[0]?.trim() || '';
        sessionVenue = (parts[1] || '').trim();
      }

      const start = headers[i].index + headers[i][0].length;
      const end = i + 1 < headers.length ? headers[i + 1].index : content.length;
      sessionBlock = content.substring(start, end);
      break;
    }

    if (sessionBlock) break;
  }

  if (!sessionBlock) return null;

  const goingMatch = sessionBlock.match(/Going:?([\s\S]*?)(?:Not Available:|$)/i);
  if (!goingMatch) return { volunteers: [], time: sessionTime, venueCode: sessionVenue };

  const volunteers = goingMatch[1]
    .split('\n')
    .map(l =>
      l.replace(/^[-•]\s*/, '') // remove bullets
       .replace(/\*\*/g, '')    // remove ONLY double asterisks
       .trim()
    )
    .filter(l =>
      l.length > 0 &&
      !/Going|Not Available/i.test(l)
    )
    .map(resolveVolunteerName);

  return { volunteers, time: sessionTime, venueCode: sessionVenue };
}

// ─── GENERATE LIST ──────────────────────────────────

async function generateMondayList(sourceChannel, targetChannel) {
  const saturday = getNextSaturday();
  const result = await getVolunteersForDate(sourceChannel, saturday);

  if (!result) {
    await targetChannel.send(`⚠️ Could not find schedule for ${formatDate(saturday)}`);
    return;
  }

  const { volunteers, time, venueCode } = result;
  const { venue, courts } = resolveVenue(venueCode);

  const lines = [];
  let slotNum = 1;

  for (const vol of volunteers) {
    lines.push(`${slotNum}. *${vol}`);
    slotNum++;
  }

  for (let i = slotNum; i <= 24; i++) {
    lines.push(`${i}.`);
  }

  const msg = [
    `Date: ${formatDate(saturday)}`,
    `Time: ${time}`,
    `Where: ${venue}`,
    `Courts: ${courts}`,
    '',
    ...lines,
    '',
    'Waitlist',
    ...Array.from({ length: 5 }, (_, i) => `${i + 1}.`)
  ].join('\n');

  await targetChannel.send(msg);
}

// ─── COMMAND HANDLER ────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== TARGET_CHANNEL_ID) return;

  const content = message.content.trim();
  const userId = message.author.id;

  if (content === '!generatelist') {
    const source = await client.channels.fetch(SOURCE_CHANNEL_ID);
    const target = await client.channels.fetch(TARGET_CHANNEL_ID);
    await generateMondayList(source, target);
    return;
  }
});

// ─── SCHEDULER ──────────────────────────────────────

cron.schedule('56 10 * * 1', async () => {
  try {
    const source = await client.channels.fetch(SOURCE_CHANNEL_ID);
    const target = await client.channels.fetch(TARGET_CHANNEL_ID);
    await generateMondayList(source, target);
  } catch (err) {
    console.error(err);
  }
});

// ─── READY ──────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

client.login(BOT_TOKEN);