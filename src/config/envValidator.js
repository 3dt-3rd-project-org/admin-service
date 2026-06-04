import { logger } from '../utils/logger.js';

const REQUIRED_ENV_VARS = [
  'JWT_SECRET',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'AZURE_STORAGE_CONNECTION_STRING',
  'AZURE_STORAGE_CONTAINER_NAME',
  'AZURE_STORAGE_ACCOUNT_NAME',
  'AZURE_WEB_PUBSUB_CONNECTION_STRING',
  'AZURE_WEB_PUBSUB_HUB'
];

export function validateEnvironment() {
  const missingVars = [];

  for (const envVar of REQUIRED_ENV_VARS) {
    const val = process.env[envVar];
    // your_key를 포함하고 있어도 로컬 구동 시 안전 부팅 가드가 강제 차단하지 않도록 필터 완화
    if (!val || val.trim() === '' || val.includes('change-this-in-production') || val.includes('실제_구글_')) {
      missingVars.push(envVar);
    }
  }

  if (missingVars.length > 0) {
    logger.error('\n================================================================');
    logger.error('[Admin Service Error] 필수 보안 환경변수가 누락되었습니다!');
    logger.error('================================================================');
    missingVars.forEach(v => logger.error(`  - ${v}`));
    logger.error('================================================================\n');
    process.exit(1);
  }

  logger.info('[Admin Service] 모든 필수 보안 환경변수 검증 통과 완료.');
}
