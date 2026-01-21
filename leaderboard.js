// Leaderboard Generator
// Computes engagement stats from the activity log

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const ACTIVITIES_PATH = path.join(DATA_DIR, 'activities.csv');
const SNAPSHOTS_PATH = path.join(DATA_DIR, 'snapshots.csv');
const LEADERBOARD_PATH = path.join(DATA_DIR, 'leaderboard.json');
const LEADERBOARD_MD_PATH = path.join(DATA_DIR, 'leaderboard.md');

// Presence heuristics
const SESSION_GAP_MINUTES = 15;    // Room idle for 15 min = session ends
const MAX_IDLE_MINUTES = 90;       // Max 1.5 hours credit after last activity

// Parse CSV file
function parseCSV(csvPath) {
  if (!fs.existsSync(csvPath)) {
    return [];
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.trim().split('\n');

  if (lines.length < 2) return [];

  const headers = lines[0].split(',');
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const record = {};
    headers.forEach((h, idx) => {
      record[h.trim()] = values[idx]?.trim() || '';
    });
    records.push(record);
  }

  return records;
}

// Get week string from date
function getWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

// Get date string
function getDate(date) {
  return new Date(date).toISOString().split('T')[0];
}

// Calculate engagement from activity log
function calculateEngagement(activities, snapshots) {
  // Sort activities by time
  activities.sort((a, b) => new Date(a.estimated_time) - new Date(b.estimated_time));

  // Group activities into "sessions" (periods of room activity separated by idle gaps)
  const sessions = [];
  let currentSession = null;

  for (const activity of activities) {
    const activityTime = new Date(activity.estimated_time);

    if (!currentSession) {
      currentSession = {
        start: activityTime,
        end: activityTime,
        users: new Map(), // user -> { firstActivity, lastActivity, activities[] }
        activities: []
      };
    } else {
      const gapMinutes = (activityTime - currentSession.end) / 1000 / 60;

      if (gapMinutes > SESSION_GAP_MINUTES) {
        // Session ended - 15+ min gap in room activity
        sessions.push(currentSession);
        currentSession = {
          start: activityTime,
          end: activityTime,
          users: new Map(),
          activities: []
        };
      }
    }

    // Update session end time (only if later, to preserve timer extensions)
    if (activityTime > currentSession.end) {
      currentSession.end = activityTime;
    }
    currentSession.activities.push(activity);

    // Track per-user timing
    if (!currentSession.users.has(activity.user)) {
      currentSession.users.set(activity.user, {
        firstActivity: activityTime,
        lastActivity: activityTime,
        activities: []
      });
    }
    const userData = currentSession.users.get(activity.user);
    userData.activities.push(activity);

    // Update lastActivity only if this activity is later
    // (preserves timer extensions from earlier activities)
    if (activityTime > userData.lastActivity) {
      userData.lastActivity = activityTime;
    }

    // If starting a timer, extend user's lastActivity and session end by timer duration
    const durationMatch = activity.action.match(/(\d+)\s*minute/i);
    if (durationMatch && activity.action.includes('started')) {
      const duration = parseInt(durationMatch[1]);
      const timerEnd = new Date(activityTime.getTime() + duration * 60 * 1000);
      if (timerEnd > userData.lastActivity) {
        userData.lastActivity = timerEnd;
      }
      if (timerEnd > currentSession.end) {
        currentSession.end = timerEnd;
      }
    }
  }

  if (currentSession) {
    sessions.push(currentSession);
  }

  // Calculate engagement per user
  const userEngagement = {};

  for (const session of sessions) {
    const week = getWeek(session.start);
    const date = getDate(session.start);

    for (const [user, userData] of session.users) {
      if (!userEngagement[user]) {
        userEngagement[user] = {
          totalMinutes: 0,
          sessionCount: 0,
          activitiesCount: 0,
          byWeek: {},
          byDate: {},
          firstSeen: userData.firstActivity,
          lastSeen: userData.lastActivity
        };
      }

      // Calculate user's presence in this session:
      // - Starts at their first activity
      // - Ends at: min(lastActivity + 90 min idle cap, session end)
      const userStart = userData.firstActivity;
      const idleCapEnd = new Date(userData.lastActivity.getTime() + MAX_IDLE_MINUTES * 60 * 1000);
      const userEnd = new Date(Math.min(idleCapEnd.getTime(), session.end.getTime()));
      const userDurationMinutes = Math.max(1, (userEnd - userStart) / 1000 / 60);

      // Check if they actively participated
      const isActiveParticipant = userData.activities.some(a =>
        a.action.includes('started') || a.action.includes('joined')
      );

      if (isActiveParticipant) {
        userEngagement[user].totalMinutes += userDurationMinutes;
        userEngagement[user].sessionCount++;
      }

      userEngagement[user].activitiesCount += userData.activities.length;

      // Update first/last seen
      if (userData.firstActivity < userEngagement[user].firstSeen) {
        userEngagement[user].firstSeen = userData.firstActivity;
      }
      if (userData.lastActivity > userEngagement[user].lastSeen) {
        userEngagement[user].lastSeen = userData.lastActivity;
      }

      // By week
      if (!userEngagement[user].byWeek[week]) {
        userEngagement[user].byWeek[week] = { minutes: 0, sessions: 0 };
      }
      if (isActiveParticipant) {
        userEngagement[user].byWeek[week].minutes += userDurationMinutes;
        userEngagement[user].byWeek[week].sessions++;
      }

      // By date
      if (!userEngagement[user].byDate[date]) {
        userEngagement[user].byDate[date] = { minutes: 0, sessions: 0 };
      }
      if (isActiveParticipant) {
        userEngagement[user].byDate[date].minutes += userDurationMinutes;
        userEngagement[user].byDate[date].sessions++;
      }
    }
  }

  return { userEngagement, sessions };
}

// Format duration
function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

// Generate markdown leaderboard
function generateMarkdown(userEngagement, sessions) {
  let md = '# Cuckoo Engagement Leaderboard\n\n';
  md += `*Generated: ${new Date().toLocaleString()}*\n\n`;
  md += `*Total sessions tracked: ${sessions.length}*\n\n`;

  // All-time leaderboard
  md += '## All-Time Leaderboard\n\n';
  md += '| Rank | User | Total Time | Sessions | First Seen |\n';
  md += '|------|------|------------|----------|------------|\n';

  const ranked = Object.entries(userEngagement)
    .map(([user, data]) => ({
      user,
      minutes: data.totalMinutes,
      sessions: data.sessionCount,
      firstSeen: data.firstSeen
    }))
    .sort((a, b) => b.minutes - a.minutes);

  ranked.forEach((entry, idx) => {
    md += `| ${idx + 1} | ${entry.user} | ${formatDuration(entry.minutes)} | ${entry.sessions} | ${getDate(entry.firstSeen)} |\n`;
  });

  // Weekly leaderboards
  const allWeeks = new Set();
  Object.values(userEngagement).forEach(data => {
    Object.keys(data.byWeek).forEach(w => allWeeks.add(w));
  });

  const weeks = Array.from(allWeeks).sort().reverse().slice(0, 4);

  for (const week of weeks) {
    md += `\n## Week ${week}\n\n`;
    md += '| Rank | User | Time | Sessions |\n';
    md += '|------|------|------|----------|\n';

    const weeklyRanked = Object.entries(userEngagement)
      .filter(([_, data]) => data.byWeek[week])
      .map(([user, data]) => ({
        user,
        minutes: data.byWeek[week].minutes,
        sessions: data.byWeek[week].sessions
      }))
      .sort((a, b) => b.minutes - a.minutes);

    if (weeklyRanked.length === 0) {
      md += '| - | No activity | - | - |\n';
    } else {
      weeklyRanked.forEach((entry, idx) => {
        md += `| ${idx + 1} | ${entry.user} | ${formatDuration(entry.minutes)} | ${entry.sessions} |\n`;
      });
    }
  }

  // Recent daily activity
  md += '\n## Recent Daily Activity\n\n';

  const allDates = new Set();
  Object.values(userEngagement).forEach(data => {
    Object.keys(data.byDate).forEach(d => allDates.add(d));
  });

  const dates = Array.from(allDates).sort().reverse().slice(0, 7);

  for (const date of dates) {
    const dayUsers = Object.entries(userEngagement)
      .filter(([_, data]) => data.byDate[date])
      .map(([user, data]) => `${user} (${formatDuration(data.byDate[date].minutes)})`)
      .join(', ');

    md += `- **${date}**: ${dayUsers || 'No activity'}\n`;
  }

  return md;
}

// Main
function main() {
  console.log('Generating leaderboard from activity log...\n');

  const activities = parseCSV(ACTIVITIES_PATH);
  const snapshots = parseCSV(SNAPSHOTS_PATH);

  console.log(`Activities in log: ${activities.length}`);
  console.log(`Timer snapshots: ${snapshots.length}`);

  if (activities.length === 0) {
    console.log('\nNo activities to process. Run the scraper first.');
    return;
  }

  const { userEngagement, sessions } = calculateEngagement(activities, snapshots);

  console.log(`\nSessions identified: ${sessions.length}`);
  console.log(`Users tracked: ${Object.keys(userEngagement).length}`);

  // Save JSON
  const jsonData = {
    generated: new Date().toISOString(),
    totalSessions: sessions.length,
    users: userEngagement
  };
  fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(jsonData, null, 2));
  console.log(`\nJSON saved to: ${LEADERBOARD_PATH}`);

  // Generate markdown
  const markdown = generateMarkdown(userEngagement, sessions);
  fs.writeFileSync(LEADERBOARD_MD_PATH, markdown);
  console.log(`Markdown saved to: ${LEADERBOARD_MD_PATH}`);

  // Print summary
  console.log('\n=== Top 5 by Engagement ===\n');
  Object.entries(userEngagement)
    .map(([user, data]) => ({ user, minutes: data.totalMinutes }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 5)
    .forEach((entry, idx) => {
      console.log(`${idx + 1}. ${entry.user}: ${formatDuration(entry.minutes)}`);
    });
}

main();
