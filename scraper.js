// Cuckoo Scraper - Collects activity feed and timer state
// Appends unique activities to a persistent log

const puppeteer = require('puppeteer');
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');

// Configuration
const ROOM_ID = process.env.CUCKOO_ROOM || 'EAGatherTownTimerEAA1';
const CUCKOO_URL = `https://cuckoo.team/${ROOM_ID}`;
const DATA_DIR = path.join(__dirname, 'data');
const ACTIVITIES_PATH = path.join(DATA_DIR, 'activities.csv');
const SNAPSHOTS_PATH = path.join(DATA_DIR, 'snapshots.csv');
const SCREENSHOT_PATH = path.join(DATA_DIR, 'latest-screenshot.png');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize CSVs with headers if they don't exist
if (!fs.existsSync(ACTIVITIES_PATH)) {
  fs.writeFileSync(ACTIVITIES_PATH, 'estimated_time,scrape_time,user,action,time_ago_raw\n');
}
if (!fs.existsSync(SNAPSHOTS_PATH)) {
  fs.writeFileSync(SNAPSHOTS_PATH, 'timestamp,timer_running,timer_value,session_type\n');
}

// Round timestamp for deduplication based on precision
// For "hours ago" activities, round to hour; for "minutes ago", round to 30 min
function roundForDedup(isoString, timeAgoRaw = '') {
  const d = new Date(isoString);
  if (timeAgoRaw.includes('hour') || timeAgoRaw.includes('day')) {
    // Coarse time - round to nearest hour
    d.setMinutes(0, 0, 0);
  } else {
    // Fine time - round to nearest 30 minutes
    const minutes = d.getMinutes();
    const roundedMinutes = Math.floor(minutes / 30) * 30;
    d.setMinutes(roundedMinutes, 0, 0);
  }
  return d.toISOString();
}

// Load existing activities to avoid duplicates
function loadExistingActivities() {
  const existing = new Set();
  if (fs.existsSync(ACTIVITIES_PATH)) {
    const content = fs.readFileSync(ACTIVITIES_PATH, 'utf8');
    const lines = content.trim().split('\n').slice(1); // Skip header
    for (const line of lines) {
      // Create a key from estimated_time (rounded) + user + action
      const parts = line.split(',');
      if (parts.length >= 5) {
        const timeAgoRaw = parts[4] || '';
        const roundedTime = roundForDedup(parts[0], timeAgoRaw);
        const key = `${roundedTime}|${parts[2]}|${parts[3]}`;
        existing.add(key);
      }
    }
  }
  return existing;
}

// Get timer state via Socket.IO (passive - no join)
async function getTimerState() {
  return new Promise((resolve) => {
    const socket = io(`https://cuckoo.team/${ROOM_ID}`, {
      transports: ['websocket'],
      reconnection: false,
    });

    let timerValue = '00:00';
    let timerRunning = false;
    let sessionType = 'unknown';

    socket.on('connect', () => {
      console.log('Socket.IO connected');
    });

    socket.on('update timer', (data) => {
      if (data) {
        timerValue = data.currentFormatted || '00:00';
        timerRunning = (data.current || 0) > 0;
      }
    });

    socket.on('update activity', (data) => {
      if (data?.timer) {
        timerValue = data.timer.currentFormatted || '00:00';
        timerRunning = (data.timer.current || 0) > 0;
      }
      if (data?.sessions?.currentType) {
        sessionType = data.sessions.currentType;
      }
    });

    socket.on('update settings', (data) => {
      if (data?.sessions?.currentType) {
        sessionType = data.sessions.currentType;
      }
    });

    setTimeout(() => {
      socket.disconnect();
      resolve({ timerValue, timerRunning, sessionType });
    }, 5000);
  });
}

// Parse time ago string to milliseconds
function parseTimeAgoMs(timeAgo) {
  if (!timeAgo) return 0;

  const match = timeAgo.match(/(\d+)\s*(sec|min|hour|day)/i);
  if (!match) return 0;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'sec': return value * 1000;
    case 'min': return value * 60 * 1000;
    case 'hour': return value * 60 * 60 * 1000;
    case 'day': return value * 24 * 60 * 60 * 1000;
    default: return 0;
  }
}

// Scrape activity feed via Puppeteer (passive - no join)
async function scrapeActivityFeed() {
  console.log('Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(CUCKOO_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 5000));

    // DO NOT press any keys or click anything - keyboard shortcuts affect the timer!
    // The activity feed is visible in the bottom-left even with the modal

    // Take screenshot
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

    // Extract activity feed
    const activities = await page.evaluate(() => {
      const items = [];
      const activityContainer = document.querySelector('.js-activity');

      if (activityContainer) {
        activityContainer.querySelectorAll('.activity__item').forEach(item => {
          const avatarEl = item.querySelector('[data-fullname]');
          const infoEl = item.querySelector('.activity__info');
          const timeEl = item.querySelector('.activity__time');

          if (infoEl) {
            items.push({
              user: avatarEl?.getAttribute('data-fullname') || 'unknown',
              action: infoEl.childNodes[0]?.textContent?.trim() || infoEl.textContent.trim(),
              timeAgo: timeEl?.textContent?.trim() || ''
            });
          }
        });
      }

      return items;
    });

    return activities;

  } finally {
    await browser.close();
  }
}

// Main scraper function
async function scrape() {
  const scrapeTime = new Date();
  console.log(`\n=== Cuckoo Scraper - ${scrapeTime.toISOString()} ===\n`);
  console.log(`Room: ${ROOM_ID}`);

  // Get timer state
  console.log('\n1. Getting timer state...');
  const { timerValue, timerRunning, sessionType } = await getTimerState();
  console.log(`   Timer: ${timerValue} (${timerRunning ? 'running' : 'stopped'}, ${sessionType})`);

  // Save timer snapshot
  const snapshotLine = `${scrapeTime.toISOString()},${timerRunning},${timerValue},${sessionType}\n`;
  fs.appendFileSync(SNAPSHOTS_PATH, snapshotLine);

  // Scrape activity feed
  console.log('\n2. Scraping activity feed...');
  const activities = await scrapeActivityFeed();
  console.log(`   Found ${activities.length} activities`);

  // Load existing activities for deduplication
  const existingActivities = loadExistingActivities();
  console.log(`   Existing activities in log: ${existingActivities.size}`);

  // Process and save new activities
  let newCount = 0;
  const newLines = [];

  for (const activity of activities) {
    const { user, action, timeAgo } = activity;

    // Skip system messages
    if (user === 'cuckoo' || user === 'unknown') continue;

    // Estimate actual time of activity
    const timeAgoMs = parseTimeAgoMs(timeAgo);
    const estimatedTime = new Date(scrapeTime.getTime() - timeAgoMs);

    // Store the original estimated time (best precision we have)
    estimatedTime.setSeconds(0, 0);
    const estimatedTimeStr = estimatedTime.toISOString();

    // Create dedup key using rounded time
    const roundedTimeStr = roundForDedup(estimatedTimeStr, timeAgo);
    const key = `${roundedTimeStr}|${user}|${action}`;

    if (!existingActivities.has(key)) {
      existingActivities.add(key);
      // Escape commas in action
      const safeAction = action.replace(/,/g, ';');
      const line = `${estimatedTimeStr},${scrapeTime.toISOString()},${user},${safeAction},${timeAgo}\n`;
      newLines.push(line);
      newCount++;
    }
  }

  // Append new activities
  if (newLines.length > 0) {
    fs.appendFileSync(ACTIVITIES_PATH, newLines.join(''));
  }

  console.log(`   New activities added: ${newCount}`);

  // Show recent activities
  if (activities.length > 0) {
    console.log('\n   Recent activities:');
    activities.slice(0, 5).forEach(a => {
      console.log(`     - [${a.user}] ${a.action} (${a.timeAgo})`);
    });
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Timer: ${timerValue} (${timerRunning ? 'running' : 'stopped'})`);
  console.log(`Session type: ${sessionType}`);
  console.log(`Activities scraped: ${activities.length}`);
  console.log(`New activities logged: ${newCount}`);
  console.log(`\nData saved to:`);
  console.log(`  - ${ACTIVITIES_PATH}`);
  console.log(`  - ${SNAPSHOTS_PATH}`);
  console.log(`  - ${SCREENSHOT_PATH}`);

  return { timerValue, timerRunning, sessionType, activitiesScraped: activities.length, newActivities: newCount };
}

// Run
scrape().catch(err => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
