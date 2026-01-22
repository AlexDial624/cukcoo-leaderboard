// Leaderboard Generator
// Processes presence snapshots + activity feed into user stats
//
// Algorithm:
// - Timer attribution: +1 count if present at timer start OR joined within 5 min
// - Work/break time: Only actual overlap between presence and timer running
// - Join time: Activity feed "joined" (precise) or assume right after last snapshot
// - Leave time: Just before disappearance snapshot, or after last timer ended
// - Gap protection: Cap assumed presence if >30 min between snapshots

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const ACTIVITIES_PATH = path.join(DATA_DIR, 'activities.csv');
const PRESENCE_PATH = path.join(DATA_DIR, 'presence.csv');
const SNAPSHOTS_PATH = path.join(DATA_DIR, 'snapshots.csv');
const SESSION_LOG_PATH = path.join(DATA_DIR, 'session_log.json');
const LEADERBOARD_PATH = path.join(DATA_DIR, 'leaderboard.json');

const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes grace period for timer attribution
const MAX_GAP_MS = 30 * 60 * 1000; // 30 min max gap for presence assumption

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

// Extract timer events from activity feed
function extractTimerEvents(activities) {
  const timers = [];

  for (const activity of activities) {
    const time = new Date(activity.estimated_time);
    const user = activity.user;
    const action = activity.action || '';

    if (user === 'cuckoo' || user === 'unknown') continue;

    // Parse timer starts
    const workMatch = action.match(/started.*?(\d+)\s*minute.*?work/i);
    const breakMatch = action.match(/started.*?(\d+)\s*minute.*?break/i);
    const timerMatch = action.match(/started.*?(\d+)\s*minute/i);

    let timerType = null;
    let duration = 0;

    if (workMatch) {
      timerType = 'work';
      duration = parseInt(workMatch[1]);
    } else if (breakMatch) {
      timerType = 'break';
      duration = parseInt(breakMatch[1]);
    } else if (timerMatch && action.includes('break')) {
      timerType = 'break';
      duration = parseInt(timerMatch[1]);
    } else if (timerMatch) {
      timerType = 'work';
      duration = parseInt(timerMatch[1]);
    }

    if (timerType) {
      timers.push({
        startTime: time,
        endTime: new Date(time.getTime() + duration * 60 * 1000),
        type: timerType,
        duration: duration,
        startedBy: user
      });
    }
  }

  // Sort by start time
  timers.sort((a, b) => a.startTime - b.startTime);
  return timers;
}

// Extract join events from activity feed (for precise join times)
function extractJoinEvents(activities) {
  const joins = {};

  for (const activity of activities) {
    const time = new Date(activity.estimated_time);
    const user = activity.user;
    const action = activity.action || '';

    if (user === 'cuckoo' || user === 'unknown') continue;

    if (action.includes('joined')) {
      if (!joins[user]) joins[user] = [];
      joins[user].push(time);
    }
  }

  return joins;
}

// Build presence windows for each user from presence snapshots
function buildPresenceWindows(presenceData, joinEvents) {
  const userWindows = {};
  let previousSnapshot = null;
  let previousUsers = new Set();

  for (const snapshot of presenceData) {
    const snapshotTime = new Date(snapshot.timestamp);
    const currentUsers = new Set(
      snapshot.users ? snapshot.users.split(';').filter(u => u) : []
    );

    // Calculate gap from previous snapshot
    const gapMs = previousSnapshot
      ? snapshotTime - new Date(previousSnapshot.timestamp)
      : 0;

    // Process each user
    for (const user of currentUsers) {
      if (!userWindows[user]) {
        userWindows[user] = [];
      }

      // User just appeared (wasn't in previous snapshot)
      if (!previousUsers.has(user)) {
        // Try to find a precise join time from activity feed
        let joinTime = null;
        const userJoins = joinEvents[user] || [];

        // Look for a join event between previous snapshot and this one
        for (const jt of userJoins) {
          if (previousSnapshot) {
            const prevTime = new Date(previousSnapshot.timestamp);
            if (jt > prevTime && jt <= snapshotTime) {
              joinTime = jt;
              break;
            }
          } else if (jt <= snapshotTime) {
            joinTime = jt;
            break;
          }
        }

        // If no precise join time, assume right after previous snapshot
        // But cap at MAX_GAP_MS for gap protection
        if (!joinTime) {
          if (previousSnapshot && gapMs <= MAX_GAP_MS) {
            // Assume joined right after previous snapshot (generous)
            joinTime = new Date(new Date(previousSnapshot.timestamp).getTime() + 1000);
          } else if (previousSnapshot && gapMs > MAX_GAP_MS) {
            // Gap too large, assume joined MAX_GAP_MS before this snapshot
            joinTime = new Date(snapshotTime.getTime() - MAX_GAP_MS);
          } else {
            // No previous snapshot, assume joined at this snapshot
            joinTime = snapshotTime;
          }
        }

        // Start a new window
        userWindows[user].push({
          joinTime: joinTime,
          leaveTime: null // Will be set when they leave
        });
      }
    }

    // Process users who left (were in previous but not current)
    for (const user of previousUsers) {
      if (!currentUsers.has(user) && userWindows[user]) {
        // Find the open window and close it
        const openWindow = userWindows[user].find(w => w.leaveTime === null);
        if (openWindow) {
          // Assume left just before this snapshot (generous)
          openWindow.leaveTime = new Date(snapshotTime.getTime() - 1000);
        }
      }
    }

    previousSnapshot = snapshot;
    previousUsers = currentUsers;
  }

  // Close any still-open windows (user is currently present)
  const now = new Date();
  for (const user of Object.keys(userWindows)) {
    for (const window of userWindows[user]) {
      if (window.leaveTime === null) {
        window.leaveTime = now; // Still present
        window.stillPresent = true;
      }
    }
  }

  return userWindows;
}

// Check if a user was present during a time range
function wasPresent(userWindows, user, startTime, endTime) {
  const windows = userWindows[user] || [];
  for (const w of windows) {
    // Check for overlap
    if (w.joinTime <= endTime && w.leaveTime >= startTime) {
      return true;
    }
  }
  return false;
}

// Check if user was present at timer start or joined within grace period
function eligibleForTimerCount(userWindows, user, timerStartTime) {
  const windows = userWindows[user] || [];
  const graceEnd = new Date(timerStartTime.getTime() + GRACE_PERIOD_MS);

  for (const w of windows) {
    // Was present at timer start
    if (w.joinTime <= timerStartTime && w.leaveTime >= timerStartTime) {
      return true;
    }
    // Joined within grace period and timer was still going
    if (w.joinTime > timerStartTime && w.joinTime <= graceEnd) {
      return true;
    }
  }
  return false;
}

// Calculate overlap in minutes between a user's presence and a timer
function calculateOverlap(userWindows, user, timerStart, timerEnd) {
  const windows = userWindows[user] || [];
  let totalOverlapMs = 0;

  for (const w of windows) {
    // Calculate overlap
    const overlapStart = Math.max(w.joinTime.getTime(), timerStart.getTime());
    const overlapEnd = Math.min(w.leaveTime.getTime(), timerEnd.getTime());

    if (overlapEnd > overlapStart) {
      totalOverlapMs += (overlapEnd - overlapStart);
    }
  }

  return totalOverlapMs / (1000 * 60); // Convert to minutes
}

// Calculate total presence time for a user
function calculatePresenceTime(windows) {
  let totalMs = 0;
  for (const w of windows) {
    totalMs += (w.leaveTime.getTime() - w.joinTime.getTime());
  }
  return totalMs / (1000 * 60); // Convert to minutes
}

// Calculate user statistics
function calculateUserStats(userWindows, timers) {
  const userStats = {};

  // Initialize stats for all users who have presence windows
  for (const user of Object.keys(userWindows)) {
    const windows = userWindows[user];
    const firstWindow = windows[0];
    const lastWindow = windows[windows.length - 1];

    userStats[user] = {
      totalPresenceMinutes: calculatePresenceTime(windows),
      totalWorkMinutes: 0,
      totalBreakMinutes: 0,
      pomodoroCount: 0,
      breakCount: 0,
      firstSeen: firstWindow?.joinTime.toISOString(),
      lastSeen: lastWindow?.leaveTime.toISOString(),
      currentlyPresent: lastWindow?.stillPresent || false
    };
  }

  // Process each timer and attribute to eligible users
  for (const timer of timers) {
    for (const user of Object.keys(userWindows)) {
      // Check if user is eligible for this timer's count
      if (eligibleForTimerCount(userWindows, user, timer.startTime)) {
        if (timer.type === 'work') {
          userStats[user].pomodoroCount++;
        } else {
          userStats[user].breakCount++;
        }
      }

      // Calculate actual overlap time
      const overlapMinutes = calculateOverlap(
        userWindows,
        user,
        timer.startTime,
        timer.endTime
      );

      if (overlapMinutes > 0) {
        if (timer.type === 'work') {
          userStats[user].totalWorkMinutes += overlapMinutes;
        } else {
          userStats[user].totalBreakMinutes += overlapMinutes;
        }
      }
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

// Build activity log showing timers with participants
function buildActivityLog(timers, userWindows) {
  const activityLog = [];

  for (const timer of timers) {
    const participants = [];

    // Find all users who were eligible for this timer
    for (const user of Object.keys(userWindows)) {
      if (eligibleForTimerCount(userWindows, user, timer.startTime)) {
        participants.push(user);
      }
    }

    activityLog.push({
      time: timer.startTime.toISOString(),
      endTime: timer.endTime.toISOString(),
      type: timer.type,
      duration: timer.duration,
      startedBy: timer.startedBy,
      participants: participants
    });
  }

  // Sort by time descending (most recent first)
  activityLog.sort((a, b) => new Date(b.time) - new Date(a.time));

  return activityLog;
}

// Generate leaderboard data
function generateLeaderboard(userStats, latestPresence, timers, userWindows) {
  const now = new Date();

  // Get currently present users from the LATEST presence snapshot (most accurate)
  const currentlyPresent = latestPresence
    ? latestPresence.split(';').filter(u => u)
    : [];

  // Update userStats to reflect actual presence from latest snapshot
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

  // Build activity log
  const activityLog = buildActivityLog(timers, userWindows);

  return {
    generated: now.toISOString(),
    currentlyPresent,
    totalUsers: ranked.length,
    totalPomodoros: ranked.reduce((sum, u) => sum + u.pomodoroCount, 0),
    totalWorkMinutes: ranked.reduce((sum, u) => sum + u.totalWorkMinutes, 0),
    activityLog: activityLog,
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

  // Extract timer events from activity feed
  const timers = extractTimerEvents(activities);
  console.log(`\nTimers found: ${timers.length}`);

  // Extract precise join events from activity feed
  const joinEvents = extractJoinEvents(activities);
  console.log(`Users with join events: ${Object.keys(joinEvents).length}`);

  // Build presence windows for each user
  const userWindows = buildPresenceWindows(presence, joinEvents);
  console.log(`Users with presence windows: ${Object.keys(userWindows).length}`);

  // Calculate stats
  const userStats = calculateUserStats(userWindows, timers);
  console.log(`Users tracked: ${Object.keys(userStats).length}`);

  // Save session log (intermediate format for debugging)
  const sessionLog = {
    lastUpdated: new Date().toISOString(),
    timerCount: timers.length,
    timers: timers.map(t => ({
      startTime: t.startTime.toISOString(),
      endTime: t.endTime.toISOString(),
      type: t.type,
      duration: t.duration,
      startedBy: t.startedBy
    })),
    userWindows: Object.fromEntries(
      Object.entries(userWindows).map(([user, windows]) => [
        user,
        windows.map(w => ({
          joinTime: w.joinTime.toISOString(),
          leaveTime: w.leaveTime.toISOString(),
          stillPresent: w.stillPresent || false
        }))
      ])
    ),
    userStats
  };
  fs.writeFileSync(SESSION_LOG_PATH, JSON.stringify(sessionLog, null, 2));
  console.log(`\nSession log saved to: ${SESSION_LOG_PATH}`);

  // Get latest presence snapshot for accurate "currently present"
  const latestPresence = presence.length > 0
    ? presence[presence.length - 1].users
    : '';

  // Generate leaderboard
  const leaderboard = generateLeaderboard(userStats, latestPresence, timers, userWindows);
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
    console.log(`${i + 1}. ${u.user}${status}: ${formatDuration(u.totalPresenceMinutes)} presence, ${u.pomodoroCount} pomodoros, ${formatDuration(u.totalWorkMinutes)} work`);
  });
}

main();
