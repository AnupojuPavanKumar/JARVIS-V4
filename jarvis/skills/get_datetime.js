// JARVIS Skill: Get Date & Time
const now = new Date();
const result = {
  ok: true,
  skill: 'get_datetime',
  data: {
    time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    iso: now.toISOString(),
    timestamp: now.getTime(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    day: now.toLocaleDateString('en-GB', { weekday: 'long' }),
    hours: now.getHours(),
    minutes: now.getMinutes()
  }
};
console.log(JSON.stringify(result));
