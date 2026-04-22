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

const CHANNEL_ID = process.env.CHANNEL_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

// Tracks ongoing command sessions: userId -> { step, rawList, command }
const activeSessions = {};

// ─── HELPERS ────────────────────────────────────────────────────────────────

function getNextSaturday() {
  // Get current date in PHT using Intl
  const now = new Date();
  const phtParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short',
  }).formatToParts(now);

  const weekday = phtParts.find(p => p.type === 'weekday').value; // e.g. "Mon"
  const month = parseInt(phtParts.find(p => p.type === 'month').value) - 1;
  const day = parseInt(phtParts.find(p => p.type === 'day').value);
  const year = parseInt(phtParts.find(p => p.type === 'year').value);

  const dayIndex = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(weekday);
  const daysUntilSat = dayIndex === 6 ? 7 : (6 - dayIndex); // if today is Sat, get NEXT Sat
  // For Monday list generation, we always want the upcoming Saturday (not today)

  const sat = new Date(year, month, day + daysUntilSat);
  return sat;
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function resolveVenue(courtsRaw) {
  if (/annex/i.test(courtsRaw)) return { venue: 'CCF Annex Gym', courts: courtsRaw.replace(/annex\s*/i, '').trim() };
  if (/gm/i.test(courtsRaw)) return { venue: 'Goodminton Smash Zone', courts: courtsRaw.replace(/gm\s*/i, '').trim() };
  return { venue: 'TBA', courts: courtsRaw.trim() };
}

function isPaid(text) {
  return /\b(paid|pd)\b|\(paid\)/i.test(text);
}

function isVolunteer(text) {
  return text.trim().startsWith('*');
}

async function sendChunked(channel, text, replyMsg) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? current + '\n' + line : line;
    if (next.length > 1900) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  if (replyMsg) await replyMsg.reply('✅ Done! Here\'s the updated list:');
  else await channel.send('✅ Done! Here\'s the updated list:');

  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

// ─── MONDAY: READ VOLUNTEERS FROM DISCORD ───────────────────────────────────

async function getVolunteersForDate(channel, targetDate) {
  const messages = await channel.messages.fetch({ limit: 50 });

  const monthLong = targetDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Manila' });   // "April"
  const monthShort = targetDate.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Manila' }); // "Apr"
  const day = targetDate.getDate();
  const dayPadded = String(day).padStart(2, '0');

  // Cover all common formats: "April 25", "April 25,", "Apr 25", "Apr 25,", "April 5", etc.
  const datePatterns = [
    `${monthLong} ${day}`,
    `${monthLong} ${dayPadded}`,
    `${monthShort} ${day}`,
    `${monthShort} ${dayPadded}`,
    `${monthLong.toUpperCase()} ${day}`,
    `${monthLong.toUpperCase()} ${dayPadded}`,
    `${monthShort.toUpperCase()} ${day}`,
    `${monthShort.toUpperCase()} ${dayPadded}`,
  ];

  let sessionBlock = null;
  let sessionTime = '';
  let sessionVenue = '';
  let sessionCourts = '';

  for (const [, msg] of messages) {
    const content = msg.content;

    const hasDate = datePatterns.some(p => content.includes(p));
    if (!hasDate) continue;

    // Match bold headers with any month/date format: **Apr 25 (...)** or **April 25 (...)**
    const headers = [...content.matchAll(/\*\*([A-Za-z]+ \d+[^*]*)\*\*/g)];

    for (let i = 0; i < headers.length; i++) {
      const headerText = headers[i][1];
      const matchesDate = datePatterns.some(p => headerText.startsWith(p));
      if (!matchesDate) continue;

      // Extract time and courts: "May 2 (3:00PM to 6:00PM, Annex 4 courts)"
      const timeMatch = headerText.match(/\(([^)]+)\)/);
      if (timeMatch) {
        const parts = timeMatch[1].split(',');
        sessionTime = parts[0]?.trim() || '';
        sessionCourts = parts[1]?.trim() || '';
      }

      // Venue and courts are both derived from the courts field e.g. "Annex 4 courts"
      // resolveVenue is called later in generateMondayList after sessionCourts is set

      const blockStart = headers[i].index + headers[i][0].length;
      const blockEnd = i + 1 < headers.length ? headers[i + 1].index : content.length;
      sessionBlock = content.substring(blockStart, blockEnd);
      break;
    }

    if (sessionBlock) break;
  }

  if (!sessionBlock) return null;

  const goingMatch = sessionBlock.match(/\*Going:\*([\s\S]*?)(?:\*Not Available:\*|$)/i);
  if (!goingMatch) return { volunteers: [], time: sessionTime, venue: sessionVenue, courts: sessionCourts };

  const goingLines = goingMatch[1]
    .split('\n')
    .map(l => l.replace(/^[-•]\s*/, '').trim())
    .filter(l => l.length > 0);

  // Tentative = confirmed
  const volunteers = goingLines.map(name => name.replace(/\s*\(tentative\)/i, '').trim());

  return { volunteers, time: sessionTime, venue: sessionVenue, courts: sessionCourts };
}

async function generateMondayList(channel) {
  const saturday = getNextSaturday();
  const result = await getVolunteersForDate(channel, saturday);

  if (!result) {
    await channel.send(
      `⚠️ Could not find a schedule entry for **${formatDate(saturday)}** in this channel. Please check the schedule post.`
    );
    return;
  }

  const { volunteers, time, courts: rawCourts } = result;
  const { venue, courts } = resolveVenue(rawCourts);
  const dateStr = formatDate(saturday);

  const lines = [];
  let slotNum = 1;
  for (const vol of volunteers) {
    lines.push(`${slotNum}. *${vol}`);
    slotNum++;
  }
  for (let i = slotNum; i <= 24; i++) {
    lines.push(`${i}.  `);
  }

  const header = [
    `Date: ${dateStr}`,
    `Time: ${time}`,
    `Where: ${venue}`,
    `Courts: ${courts}`,
    '',
    'REMINDERS:',
    '1. If you are playing for the first time in this group, please answer the one time registration form at https://bit.ly/SabadomintonMember.',
    '2. Please pay game fee of P240 (court fee + shuttle) via GCash to JERBY LOPEZ at (09172742771) and indicate in the note: Badminton Fee from <Nickname>. Send GCash Receipt here in the GC with your full name and tag your name as paid.',
    '3. No payment, no play. Deadline of payment is on Wed, 7pm. Otherwise, your slot will be given to waitlisted players. Waitlisted players must pay by Thurs, 7pm to secure their slots.',
    '4. Payments made after Thurs 7pm, including same day walk-ins will be charged with P260.',
    '5. Any cancellations made after the Thurs 7pm cut off will be considered FORFEITED and cannot be used in succeeding games UNLESS a replacement is found. Please understand that we pay the court according to the confirmed players by cutoff.',
    '6. The untaken (and unpaid) reserved slots for first timers will be given to waitlisted players by Wed 7pm.',
    '7. For any questions/concerns, please reach out to any of the volunteers marked with * below.',
    '',
    'Thanks and see you!',
    '',
  ].join('\n');

  const slotList = lines.join('\n');
  const waitlist = '\nWaitlist\n' + Array.from({ length: 5 }, (_, i) => `${i + 1}.  `).join('\n');
  const fullMessage = header + slotList + waitlist;

  if (fullMessage.length <= 2000) {
    await channel.send(fullMessage);
  } else {
    await channel.send(header);
    await channel.send(slotList + waitlist);
  }
}

// ─── LIST PARSER ─────────────────────────────────────────────────────────────

function parseViberList(raw) {
  const lines = raw.split('\n');

  let header = [];
  let slots = [];
  let waitlist = [];
  let inReminders = false;
  let inSlots = false;
  let inWaitlist = false;
  let reminderLines = [];
  let thankYouLines = [];
  let inThankYou = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^REMINDERS:/i.test(trimmed)) { inReminders = true; inThankYou = false; }
    if (/^Thanks and see you/i.test(trimmed)) { inReminders = false; inThankYou = true; }
    if (/^Waitlist/i.test(trimmed)) { inWaitlist = true; inSlots = false; inThankYou = false; continue; }

    // Skip existing markers
    if (/———.*———/.test(trimmed)) continue;

    const slotMatch = trimmed.match(/^(\d+)\.\s*(.*)/);

    // Only treat as player slots AFTER "Thanks and see you!" or when already in slots/waitlist
    // Prevents numbered reminder lines from being parsed as player slots
    if (slotMatch && (inSlots || inWaitlist || inThankYou)) {
      inSlots = !inWaitlist;
      inThankYou = false;
      const num = parseInt(slotMatch[1]);
      const text = slotMatch[2].trim();
      const paid = isPaid(text);
      const volunteer = isVolunteer(text);
      const isEmpty = text === '';

      if (inWaitlist) {
        waitlist.push({ num, text, paid, volunteer, isEmpty });
      } else {
        slots.push({ num, text, paid, volunteer, isEmpty });
      }
      continue;
    }

    if (!inSlots && !inWaitlist) {
      if (inReminders) reminderLines.push(line);
      else if (inThankYou) thankYouLines.push(line);
      else header.push(line);
    }
  }

  return { header, reminderLines, thankYouLines, slots, waitlist };
}

// ─── LIST BUILDER ─────────────────────────────────────────────────────────────

function buildList(parsed, totalSlots, includeWalkInMarker) {
  const { header, reminderLines, thankYouLines, slots, waitlist } = parsed;

  const paidSlots = slots.filter(s => !s.isEmpty && s.paid);
  const unpaidFromSlots = slots.filter(s => !s.isEmpty && !s.paid);
  const paidWaitlisted = waitlist.filter(s => !s.isEmpty && s.paid);
  const unpaidWaitlisted = waitlist.filter(s => !s.isEmpty && !s.paid);

  const promoted = [...paidSlots, ...paidWaitlisted];

  // Open slots 25-30 if 24+ paid players
  const extraSlots = promoted.length >= 24 ? 6 : 0;
  const effectiveTotal = Math.max(totalSlots, promoted.length) + extraSlots;

  // Build main slot lines
  const mainLines = [];
  for (let i = 1; i <= effectiveTotal; i++) {
    const player = promoted[i - 1];
    mainLines.push(player ? `${i}. ${player.text}` : `${i}.  `);
  }

  // P260 marker for !walkin only
  const finalMainLines = [];
  if (includeWalkInMarker) {
    let lastPaidIndex = promoted.length - 1;
    for (let i = 0; i < mainLines.length; i++) {
      finalMainLines.push(mainLines[i]);
      if (i === lastPaidIndex) finalMainLines.push('———P260 Game Fee———');
    }
    finalMainLines.push('———end of list———');
  } else {
    finalMainLines.push(...mainLines);
  }

  // Waitlist compacted from slot 1
  const newWaitlist = [...unpaidFromSlots, ...unpaidWaitlisted];
  const waitlistLines = newWaitlist.map((p, i) => `${i + 1}. ${p.text}`);
  for (let i = waitlistLines.length; i < 5; i++) {
    waitlistLines.push(`${i + 1}.  `);
  }

  const parts = [
    ...header,
    ...reminderLines,
    ...thankYouLines,
    '',
    ...finalMainLines,
    '',
    'Waitlist',
    '',
    ...waitlistLines,
  ];

  return parts.join('\n');
}

// ─── COMMAND HANDLER ─────────────────────────────────────────────────────────

async function handleListCommand(message, command, rawList) {
  if (!rawList) {
    await message.reply(`Please paste the Viber list after the command.\nExample: \`${command} [paste list here]\``);
    return;
  }
  activeSessions[message.author.id] = { step: 'awaiting_slots', rawList, command };
  await message.reply('How many slots for this session? (e.g. `24`)');
}

async function handleSlotCountReply(message, slotCount) {
  const session = activeSessions[message.author.id];
  delete activeSessions[message.author.id];

  try {
    const parsed = parseViberList(session.rawList);
    const includeWalkInMarker = session.command === '!walkin';
    const result = buildList(parsed, slotCount, includeWalkInMarker);
    await sendChunked(message.channel, result, message);
  } catch (err) {
    console.error(err);
    await message.reply('⚠️ Something went wrong parsing the list. Please check the format and try again.');
  }
}

// ─── MESSAGE LISTENER ────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== CHANNEL_ID) return;

  const content = message.content.trim();
  const userId = message.author.id;

  // !cleanup
  if (content.toLowerCase().startsWith('!cleanup')) {
    const rawList = content.slice('!cleanup'.length).trim();
    await handleListCommand(message, '!cleanup', rawList);
    return;
  }

  // !walkin
  if (content.toLowerCase().startsWith('!walkin')) {
    const rawList = content.slice('!walkin'.length).trim();
    await handleListCommand(message, '!walkin', rawList);
    return;
  }

  // Awaiting slot count reply
  if (activeSessions[userId]?.step === 'awaiting_slots') {
    const slotCount = parseInt(content);
    if (isNaN(slotCount) || slotCount < 1) {
      await message.reply('Please reply with a valid number (e.g. `24`).');
      return;
    }
    await handleSlotCountReply(message, slotCount);
    return;
  }

  // !generatelist — manual trigger for testing
  if (content === '!generatelist') {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await generateMondayList(channel);
    return;
  }

  // !help
  if (content === '!help') {
    await message.reply([
      '🏸 **saBOTominton Commands**',
      '',
      '`!generatelist`',
      'Manually generates this week\'s sign-up list with volunteers pre-filled.',
      '*(Runs automatically every Monday 6:56PM.)*',
      '',
      '`!cleanup [paste Viber list]`',
      'Cleans up the list after the Wed 7PM deadline.',
      'Moves unpaid players to waitlist, promotes paid waitlisted players to open slots.',
      '',
      '`!walkin [paste Viber list]`',
      'Same as `!cleanup` but also adds the P260 walk-in rate marker after the last paid slot.',
      'Use this after the Thursday 7PM cutoff.',
      '',
      '`!help`',
      'Shows this message.',
      '',
      '💡 **Tip:** For `!cleanup` and `!walkin`, paste the full Viber list right after the command. The bot will then ask how many slots.',
    ].join('\n'));
    return;
  }
});

// ─── SCHEDULER ───────────────────────────────────────────────────────────────

// Monday 6:56PM PHT = Monday 10:56 UTC
cron.schedule('56 10 * * 1', async () => {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    await generateMondayList(channel);
  } catch (err) {
    console.error('Monday scheduler error:', err);
  }
});

// ─── BOT READY ───────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ saBOTominton is online as ${client.user.tag}`);
});

client.login(BOT_TOKEN);
