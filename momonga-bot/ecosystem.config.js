// pm2 설정 — 모몽가(노래 봇). 다른 두 봇과 별도 프로세스
// 배포: npm run build → npm run deploy:prod → pm2 start ecosystem.config.js → pm2 save
// 코드 수정 후: npm run build → pm2 restart momonga-bot (커맨드 변경 시 deploy:prod도)
module.exports = {
  apps: [
    {
      name: 'momonga-bot',
      script: 'dist/index.js',
      args: '--env=prod',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1, // 대기열·플레이어가 메모리에 있으므로 반드시 1개
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s',
      max_memory_restart: '400M',
      // 종료 시 yt-dlp 종료·임시 파일 삭제 시간 확보 (봇은 10초 안에 스스로 종료)
      kill_timeout: 15000,
      // Windows는 시그널로 정상 종료를 못 알리므로 메시지로 전달
      shutdown_with_message: true,
      windowsHide: true,
      time: true, // 로그에 시간 표시
    },
  ],
};
