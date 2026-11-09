const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const hourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** 한국 시간 기준 YYYY-MM-DD */
export function seoulDateString(date = new Date()): string {
  return dateFormatter.format(date);
}

/** 한국 시간 기준 시(0~23) */
export function seoulHour(date = new Date()): number {
  return Number(hourFormatter.format(date));
}
