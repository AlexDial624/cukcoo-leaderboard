// Leaderboard Generator
// Processes presence snapshots + activity feed into user stats

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const ACTIVITIES_PATH = path.join(DATA_DIR, 'activities.csv');
const PRESENCE_PATH = path.join(DATA_DIR, 'presence.csv');
const SNAPSHOTS_PATH = path.join(DATA_DIR, 'snapshots.csv');
const SESSION_LOG_PATH = path.join(DATA_DIR, 'session_log.json');
const LEADERBOARD_PATH = path.join(DATA_DIR, 'leaderboard.json');

// Parse CSV file into array of objects
function parseCSV(csvPath) {
  if (!fs.existsSync(csvPath)) return [];

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const record = {};
    headers.forEach((h, idx) => {
      record[h.trim()] = values[idx]?.trim().replace(/^"|"$/g, '') || '';
    });
    return record;
  });
}

// Process presence snapshots to detect join/leave events
function processPresence(presenceData) {
  const events = [];
  let previousUsers = new Set();

  for (const snapshot of presenceData) {
    const time = new Date(snapshot.timestamp);
    const currentUsers = new Set(
      snapshot.users ? snapshot.users.split(';').filter(u => u) : []
    );

    // Detect joins (in current but not previous)
    for (const user of currentUsers) {
      if (!previousUsers.has(user)) {
        events.push({
          time: time.toISOString(),
          type: 'join',
          user: user,
          source: 'presence'
        });
      }
    }

    // Detect leaves (in previous but not current)
    for (const user of previousUsers) {
      if (!currentUsers.has(user)) {
        events.push({
          time: time.toISOString(),
          type: 'leave',
          user: user,
          source: 'presence'
        });
      }
    }

    previousUsers = currentUsers;
  }

  return events;
}

// Process activity feed for timer events
function processActivities(activities) {
  const events = [];

  for (const activity of activities) {
    const time = activity.estimated_time;
    const user = activity.user;
    const action = activity.action || '';

    // Skip system messages
    if (user === 'cuckoo' || user === 'unknown') continue;

    // Parse timer starts
    const workMatch = action.match(/started.*?(\d+)\s*minute.*?work/i);
    const breakMatch = action.match(/started.*?(\d+)\s*minute.*?break/i);
    const timerMatch = action.match(/started.*?(\d+)\s*minute/i);

    if (workMatch) {
      events.push({
        time,
        type: 'work_start',
        user,
        duration: parseInt(workMatch[1]),
        source: 'activity'
      });
    } else if (breakMatch) {
      events.push({
        time,
        type: 'break_start',
        user,
        duration: parseInt(breakMatch[1]),
        source: 'activity'
      });
    } else if (timerMatch && action.includes('break')) {
      events.push({
        time,
        type: 'break_start',
        user,
        duration: parseInt(timerMatch[1]),
        source: 'activity'
      });
    } else if (timerMatch) {
      events.push({
        time,
        type: 'work_start',
        user,
        duration: parseInt(timerMatch[1]),
        source: 'activity'
      });
    }

    // Parse stops/skips
    if (action.includes('stopped') || action.includes('skipped')) {
      events.push({
        time,
        type: 'timer_stop',
        user,
        source: 'activity'
      });
    }

    // Parse joins from activity feed (backup for presence)
    if (action.includes('joined')) {
      events.push({
        time,
        type: 'join',
        user,
        source: 'activity'
      });
    }
  }

  return events;
}

// Merge and deduplicate events
function mergeEvents(presenceEvents, activityEvents) {
  const allEvents = [...presenceEvents, ...activityEvents];

  // Sort by time
  allEvents.sort((a, b) => new Date(a.time) - new Date(b.time));

  // Deduplicate joins (prefer presence source as it's more accurate)
  const seen = new Set();
  const deduped = [];

  for (const event of allEvents) {
    // Create a key for deduplication (within 5 min window for joins)
    const timeKey = Math.floor(new Date(event.time).getTime() / (5 * 60 * 1000));
    const key = `${event.type}|${event.user}|${timeKey}`;

    if (event.type === 'join' || event.type === 'leave') {
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(event);
      }
    } else {
      deduped.push(event);
    }
  }

  return deduped;
}

// Calculate user statistics from events
function calculateUserStats(events, timerSnapshots) {
  const userStats = {};
  const userSessions = {}; // Track active sessions per user

  // Get current timer state from latest snapshot
  const latestSnapshot = timerSnapshots[timerSnapshots.length - 1];
  const currentTimerRunning = latestSnapshot?.timer_running === 'true';
  const currentTimerValue = latestSnapshot?.timer_value || '00:00';
  const currentSessionType = latestSnapshot?.session_type || 'unknown';

  for (const event of events) {
    const { user, type, time, duration } = event;

    if (!userStats[user]) {
      userStats[user] = {
        totalPresenceMinutes: 0,
        totalWorkMinutes: 0,
        totalBreakMinutes: 0,
        pomodoroCount: 0,
        breakCount: 0,
        pomodoroMinutes: [],
        breakMinutes: [],
        firstSeen: time,
        lastSeen: time,
        currentlyPresent: false
      };
    }

    userStats[user].lastSeen = time;

    if (!userSessions[user]) {
      userSessions[user] = { joinTime: null, activeTimer: null };
    }

    switch (type) {
      case 'join':
        userSessions[user].joinTime = new Date(time);
        userStats[user].currentlyPresent = true;
        break;

      case 'leave':
        if (userSessions[user].joinTime) {
          const presenceMs = new Date(time) - userSessions[user].joinTime;
          userStats[user].totalPresenceMinutes += presenceMs / (1000 * 60);
        }
        userSessions[user].joinTime = null;
        userStats[user].currentlyPresent = false;
        break;

      case 'work_start':
        userStats[user].pomodoroCount++;
        userStats[user].totalWorkMinutes += duration;
        userStats[user].pomodoroMinutes.push(duration);
        userSessions[user].activeTimer = { type: 'work', duration, startTime: time };
        break;

      case 'break_start':
        userStats[user].breakCount++;
        userStats[user].totalBreakMinutes += duration;
        userStats[user].breakMinutes.push(duration);
        userSessions[user].activeTimer = { type: 'break', duration, startTime: time };
        break;

      case 'timer_stop':
        userSessions[user].activeTimer = null;
        break;
    }
  }

  // Handle users still present (add time up to now)
  const now = new Date();
  for (const [user, session] of Object.entries(userSessions)) {
    if (session.joinTime) {
      const presenceMs = now - session.joinTime;
      userStats[user].totalPresenceMinutes += presenceMs / (1000 * 60);
      userStats[user].currentlyPresent = true;
    }
  }

  return userStats;
}

// Format duration for display
function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

// Generate leaderboard data
function generateLeaderboard(userStats, events, latestPresence) {
  const now = new Date();

  // Get currently present users from the LATEST presence snapshot (most accurate)
  const currentlyPresent = latestPresence
    ? latestPresence.split(';').filter(u => u)
    : [];

  // Update userStats to reflect actual presence
  for (const user of Object.keys(userStats)) {
    userStats[user].currentlyPresent = currentlyPresent.includes(user);
  }

  // Rank by total presence time
  const ranked = Object.entries(userStats)
    .map(([user, stats]) => ({
      user,
      ...stats,
      avgPomodoroMinutes: stats.pomodoroCount > 0
        ? Math.round(stats.totalWorkMinutes / stats.pomodoroCount)
        : 0,
      avgBreakMinutes: stats.breakCount > 0
        ? Math.round(stats.totalBreakMinutes / stats.breakCount)
        : 0
    }))
    .sort((a, b) => b.totalPresenceMinutes - a.totalPresenceMinutes);

  return {
    generated: now.toISOString(),
    currentlyPresent,
    totalUsers: ranked.length,
    totalPomodoros: ranked.reduce((sum, u) => sum + u.pomodoroCount, 0),
    totalWorkMinutes: ranked.reduce((sum, u) => sum + u.totalWorkMinutes, 0),
    users: ranked.map(u => ({
      user: u.user,
      currentlyPresent: u.currentlyPresent,
      totalPresenceMinutes: Math.round(u.totalPresenceMinutes),
      totalWorkMinutes: Math.round(u.totalWorkMinutes),
      totalBreakMinutes: Math.round(u.totalBreakMinutes),
      pomodoroCount: u.pomodoroCount,
      breakCount: u.breakCount,
      avgPomodoroMinutes: u.avgPomodoroMinutes,
      firstSeen: u.firstSeen,
      lastSeen: u.lastSeen
    }))
  };
}

// Main
function main() {
  console.log('Processing data for leaderboard...\n');

  // Load raw data
  const activities = parseCSV(ACTIVITIES_PATH);
  const presence = parseCSV(PRESENCE_PATH);
  const snapshots = parseCSV(SNAPSHOTS_PATH);

  console.log(`Activities: ${activities.length}`);
  console.log(`Presence snapshots: ${presence.length}`);
  console.log(`Timer snapshots: ${snapshots.length}`);

  if (presence.length === 0 && activities.length === 0) {
    console.log('\nNo data to process. Run the scraper first.');
    return;
  }

  // Process events
  const presenceEvents = processPresence(presence);
  const activityEvents = processActivities(activities);
  const allEvents = mergeEvents(presenceEvents, activityEvents);

  console.log(`\nPresence events: ${presenceEvents.length}`);
  console.log(`Activity events: ${activityEvents.length}`);
  console.log(`Merged events: ${allEvents.length}`);

  // Calculate stats
  const userStats = calculateUserStats(allEvents, snapshots);
  console.log(`Users tracked: ${Object.keys(userStats).length}`);

  // Save session log (intermediate format)
  const sessionLog = {
    lastUpdated: new Date().toISOString(),
    eventCount: allEvents.length,
    events: allEvents,
    userStats
  };
  fs.writeFileSync(SESSION_LOG_PATH, JSON.stringify(sessionLog, null, 2));
  console.log(`\nSession log saved to: ${SESSION_LOG_PATH}`);

  // Get latest presence snapshot for accurate "currently present"
  const latestPresence = presence.length > 0
    ? presence[presence.length - 1].users
    : '';

  // Generate leaderboard
  const leaderboard = generateLeaderboard(userStats, allEvents, latestPresence);
  fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(leaderboard, null, 2));
  console.log(`Leaderboard saved to: ${LEADERBOARD_PATH}`);

  // Print summary
  console.log('\n=== Currently Present ===');
  if (leaderboard.currentlyPresent.length > 0) {
    console.log(leaderboard.currentlyPresent.join(', '));
  } else {
    console.log('No one currently in room');
  }

  console.log('\n=== Top 5 by Presence Time ===');
  leaderboard.users.slice(0, 5).forEach((u, i) => {
    const status = u.currentlyPresent ? ' (online)' : '';
    console.log(`${i + 1}. ${u.user}${status}: ${formatDuration(u.totalPresenceMinutes)} presence, ${u.pomodoroCount} pomodoros`);
  });
}

main();
