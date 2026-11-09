// 음성 의존성(DAVE, 암호화, opus, ffmpeg) 설치 상태 확인용: npm run voice-report
import { generateDependencyReport } from '@discordjs/voice';

console.log(generateDependencyReport());
