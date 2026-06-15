import { app } from '@azure/functions';
import { WebPubSubServiceClient } from '@azure/web-pubsub';
import { logger } from '../utils/logger.js';
import { requireAdmin } from '../shared/authHelper.js';
import { handleSuccess, handleError } from '../shared/responseHelper.js';

const wpsConnectionString = process.env.AZURE_WEB_PUBSUB_CONNECTION_STRING;
const wpsHub = process.env.AZURE_WEB_PUBSUB_HUB;

let wpsClient;
if (wpsConnectionString && wpsHub) {
  try {
    wpsClient = new WebPubSubServiceClient(wpsConnectionString, wpsHub);
  } catch (err) {
    logger.error(`[Web PubSub Client Init Failed]: ${err.message}`);
  }
}

// 1. 관리자 실시간 모니터링 토큰 발급
app.http('getWebPubSubToken', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'adm/analyze/token',
  handler: async (request, context) => {
    logger.info('[Web PubSub Token Trigger] 관리자 실시간 모니터링 토큰 요청 수신');

    try {
      const user = requireAdmin(request);

      if (!wpsClient) {
        throw {
          status: 503,
          body: { error: 'Service Unavailable', message: 'Azure Web PubSub 메시징 인프라 연동이 비활성화 상태입니다.' }
        };
      }

      const wpsToken = await wpsClient.getClientAccessToken({
        roles: [`webpubsub.joinLeaveGroup.admin_${user.id}`, `webpubsub.sendToGroup.admin_${user.id}`],
        groups: [`admin_${user.id}`],
        userId: user.id.toString()
      });

      logger.info(`[Azure Web PubSub] 관리자 ${user.id} 실시간 연결 인증 토큰 발급 완료.`);

      return handleSuccess({
        message: 'Web PubSub 접속 인증 정보가 생성되었습니다.',
        url: wpsToken.url
      });
    } catch (err) {
      return handleError(err, logger, 'Web PubSub Token Trigger');
    }
  }
});
