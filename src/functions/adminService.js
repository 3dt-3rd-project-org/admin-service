import { app } from '@azure/functions';
import { BlobServiceClient, BlobSASPermissions } from '@azure/storage-blob';
import { WebPubSubServiceClient } from '@azure/web-pubsub';
import crypto from 'crypto';
import { dbPool } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { requireAdmin, verifyBookOwnership } from '../shared/authHelper.js';
import { handleSuccess, handleError } from '../shared/responseHelper.js';

const storageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const storageContainerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
const storageAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;

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

app.http('getAdminBooks', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'adm/books',
  handler: async (request, context) => {
    logger.info('[Admin Books List] 관리자 도서 목록 조회 요청 수신');
    try {
      const user = requireAdmin(request);

      const result = await dbPool.query(
        'SELECT * FROM books WHERE admin_id = $1 ORDER BY books_id DESC',
        [user.id]
      );

      logger.info(`[Admin Books List] 관리자 ${user.id} 도서 목록 조회 완료 (조회 수: ${result.rows.length}개)`);
      return handleSuccess({
        message: '도서 목록을 조회했습니다.',
        books: result.rows
      });
    } catch (err) {
      return handleError(err, logger, 'Admin Books List');
    }
  }
});

app.http('upload', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'adm/books',
  handler: async (request, context) => {
    logger.info('[Admin Book Upload] 도서 파일 직접 업로드 요청 수신');
    try {
      const user = requireAdmin(request);

      const formData = await request.formData();
      const file = formData.get('bookFile');

      if (!file || typeof file === 'string') {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Bad Request', message: 'bookFile 필드에 ePub 도서 원본 파일을 첨부해야 합니다.' })
        };
      }

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const fileName = file.name;

      const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
      const containerClient = blobServiceClient.getContainerClient(storageContainerName);

      const randomHash = crypto.randomBytes(16).toString('hex');
      const uniqueBlobName = `${randomHash}.epub`;
      const blockBlobClient = containerClient.getBlockBlobClient(uniqueBlobName);

      logger.info(`[Azure Storage] ePub 업로드 프로세스 시작: ${uniqueBlobName}`);

      await blockBlobClient.uploadData(buffer);

      const storageUrl = `https://${storageAccountName}.blob.core.windows.net/${storageContainerName}/${uniqueBlobName}`;
      logger.info(`[Azure Storage] ePub 업로드 완료 및 경로 바인딩 성공: ${storageUrl}`);

      const functionsUrl = process.env.AZURE_FUNCTIONS_METADATA_URL;
      if (functionsUrl) {
        logger.info('[Azure Functions Trigger] 메타데이터 추출 비동기 트리거 킥오프...');
        fetch(functionsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_url: storageUrl,
            admin_id: user.id
          })
        }).then(res => {
          if (!res.ok) {
            logger.error(`[Azure Functions Response] 메타데이터 트리거 응답 실패: ${res.statusText}`);
          } else {
            logger.info('[Azure Functions Trigger] 메타데이터 추출 트리거 접수 완료.');
          }
        }).catch(fetchErr => {
          logger.warn(`[Azure Functions Fetch Warning] 메타데이터 트리거 전송 실패: ${fetchErr.message}`);
        });
      }

      logger.info(`[Admin Book Upload] 도서 파일 업로드 및 분석 트리거 킥오프 완료 (Storage URL: ${storageUrl})`);
      return handleSuccess({
        message: '도서 ePub 파일 업로드가 완료되었으며, 메타데이터 추출이 백그라운드에서 진행 중입니다.',
        storageUrl
      }, 202);
    } catch (err) {
      return handleError(err, logger, 'Admin Book Upload');
    }
  }
});

app.http('updateBook', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Book Update] 도서 정보 수정 요청 수신 (도서 ID: ${bookId})`);

    try {
      const { user } = await verifyBookOwnership(request, bookId);

      const reqBody = await request.json();
      const { title, author, publisher, published_year, cover_url, isbn, epub_blob_path } = reqBody;

      if (!title) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Bad Request', message: 'title 필드는 필수입니다.' })
        };
      }

      const result = await dbPool.query(
        `UPDATE books 
         SET title = $1, 
             author = $2, 
             publisher = $3, 
             published_year = $4, 
             cover_url = $5, 
             isbn = $6, 
             epub_blob_path = $7,
             updated_at = CURRENT_TIMESTAMP
         WHERE books_id = $8 AND admin_id = $9 
         RETURNING *`,
        [
          title,
          author || null,
          publisher || null,
          published_year || null,
          cover_url || null,
          isbn || null,
          epub_blob_path || null,
          bookId,
          user.id
        ]
      );

      logger.info(`[Admin Book Update] 관리자 ${user.id}가 도서 ${bookId}의 정보를 수정했습니다.`);
      return handleSuccess({
        message: '도서 정보가 성공적으로 수정되었습니다.',
        book: result.rows[0]
      });
    } catch (err) {
      return handleError(err, logger, 'Admin Book Update');
    }
  }
});

app.http('deleteBook', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Book Delete] 도서 제거 요청 수신 (도서 ID: ${bookId})`);

    try {
      const { user, book } = await verifyBookOwnership(request, bookId);

      if (book.epub_blob_path) {
        try {
          const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
          const containerClient = blobServiceClient.getContainerClient(storageContainerName);

          const blobPath = book.epub_blob_path;
          const blobName = blobPath.substring(blobPath.lastIndexOf('/') + 1);

          if (blobName) {
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            logger.info(`[Azure Storage] 물리 ePub 제거 프로세스 기동 (DB 삭제 전): ${blobName}`);
            await blockBlobClient.deleteIfExists();
            logger.info(`[Azure Storage] 물리 ePub 제거 성공: ${blobName}`);
          }
        } catch (blobDelErr) {
          logger.error(`[Azure Storage Delete Warning] 물리 ePub 제거 중 오류 발생 (DB 삭제는 계속 진행됩니다): ${blobDelErr.message}`);
        }
      }

      if (book.cover_url) {
        try {
          const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
          const containerClient = blobServiceClient.getContainerClient("cover");

          const blobPath = book.cover_url;
          const blobName = blobPath.substring(blobPath.lastIndexOf('/') + 1);

          if (blobName) {
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            logger.info(`[Azure Storage] 물리 표지 이미지 제거 프로세스 기동 (DB 삭제 전): ${blobName}`);
            await blockBlobClient.deleteIfExists();
            logger.info(`[Azure Storage] 물리 표지 이미지 제거 성공: ${blobName}`);
          }
        } catch (blobDelErr) {
          logger.error(`[Azure Storage Delete Warning] 물리 표지 이미지 제거 중 오류 발생 (DB 삭제는 계속 진행됩니다): ${blobDelErr.message}`);
        }
      }

      const deleteResult = await dbPool.query(
        'DELETE FROM books WHERE books_id = $1 AND admin_id = $2 RETURNING *',
        [bookId, user.id]
      );

      logger.info(`[Admin Book Delete] 관리자 ${user.id}가 도서 ${bookId}를 영구 삭제했습니다.`);
      return handleSuccess({
        message: '도서가 성공적으로 삭제되었습니다.',
        book: deleteResult.rows[0]
      });
    } catch (err) {
      return handleError(err, logger, 'Admin Book Delete');
    }
  }
});

app.http('analyzeBook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/analyze',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Book Analyze] 분석 기동 요청 수신 (도서 ID: ${bookId})`);

    try {
      const { user, book } = await verifyBookOwnership(request, bookId);

      // 1. 현재 상태 검증
      if (book.status !== 'READY' && book.status !== 'ANALYZING_ERROR') {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Bad Request',
            message: `분석 파이프라인은 READY 또는 ANALYZING_ERROR 상태에서만 기동할 수 있습니다. (현재 상태: ${book.status})`
          })
        };
      }

      // 2. DB 상태 업데이트 (ANALYZING)
      const result = await dbPool.query(
        `UPDATE books 
         SET status = $1 
         WHERE books_id = $2 AND admin_id = $3 
         RETURNING *`,
        ['ANALYZING', bookId, user.id]
      );

      const updatedBook = result.rows[0];

      // 3. Logic App 호출 (ADF 파이프라인 구동)
      const logicAppUrl = process.env.AZURE_LOGIC_APP_ADF_URL;
      if (!logicAppUrl) {
        throw new Error('Logic App URL 환경 변수가 구성되지 않았습니다.');
      }

      logger.info(`[ADF Trigger] Book ${bookId} 분석 파이프라인 기동 요청 송신 중...`);
      const response = await fetch(logicAppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          books_id: bookId.toString()
        })
      });

      if (!response.ok) {
        throw new Error(`Logic App 호출 실패: ${response.statusText}`);
      }

      logger.info(`[ADF Trigger] Book ${bookId} 분석 파이프라인 기동 요청 성공 완료.`);

      return handleSuccess({
        message: '도서 분석이 정상적으로 요청되었으며, 백그라운드 분석을 진행 중입니다.',
        book: updatedBook
      });
    } catch (err) {
      logger.error(`[Admin Book Analyze] 분석 기동 중 오류 발생: ${err.message}`);
      return handleError(err, logger, 'Admin Book Analyze');
    }
  }
});

app.http('summarizeBook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/summary',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Book Summary] 요약 기동 요청 수신 (도서 ID: ${bookId})`);

    try {
      const { user, book } = await verifyBookOwnership(request, bookId);

      // 1. 현재 상태 검증
      if (book.status !== 'ANALYZING_COMPLETE' && book.status !== 'SUMMARY_ERROR') {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Bad Request',
            message: `요약 파이프라인은 ANALYZING_COMPLETE 또는 SUMMARY_ERROR 상태에서만 기동할 수 있습니다. (현재 상태: ${book.status})`
          })
        };
      }

      // 2. DB 상태 업데이트 (SUMMARIZING)
      const result = await dbPool.query(
        `UPDATE books 
         SET status = $1 
         WHERE books_id = $2 AND admin_id = $3 
         RETURNING *`,
        ['SUMMARIZING', bookId, user.id]
      );

      const updatedBook = result.rows[0];

      // 3. Logic App 호출 (ADF 파이프라인 구동)
      const logicAppUrl = process.env.AZURE_LOGIC_APP_SUMMARY_URL;
      if (!logicAppUrl) {
        throw new Error('Logic App 요약 URL 환경 변수가 구성되지 않았습니다.');
      }

      logger.info(`[ADF Summary Trigger] Book ${bookId} 요약 파이프라인 기동 요청 송신 중...`);
      const response = await fetch(logicAppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          books_id: bookId.toString()
        })
      });

      if (!response.ok) {
        throw new Error(`Logic App 호출 실패: ${response.statusText}`);
      }

      logger.info(`[ADF Summary Trigger] Book ${bookId} 요약 파이프라인 기동 요청 성공 완료.`);

      return handleSuccess({
        message: '도서 요약이 정상적으로 요청되었으며, 백그라운드 요약을 진행 중입니다.',
        book: updatedBook
      });
    } catch (err) {
      logger.error(`[Admin Book Summary] 요약 기동 중 오류 발생: ${err.message}`);
      return handleError(err, logger, 'Admin Book Summary');
    }
  }
});

app.http('approveAnalysis', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/approve-analysis',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Book Approve Analysis] 분석 결과 검수 승인 요청 수신 (도서 ID: ${bookId})`);

    try {
      const { user, book } = await verifyBookOwnership(request, bookId);

      // 1. 현재 상태 검증
      if (book.status !== 'ANALYZING_FINISHED') {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Bad Request',
            message: `분석 검수 승인은 ANALYZING_FINISHED 상태의 도서만 가능합니다. (현재 상태: ${book.status})`
          })
        };
      }

      // 2. DB 상태 업데이트 (ANALYZING_COMPLETE)
      const result = await dbPool.query(
        `UPDATE books 
         SET status = $1 
         WHERE books_id = $2 AND admin_id = $3 
         RETURNING *`,
        ['ANALYZING_COMPLETE', bookId, user.id]
      );

      const updatedBook = result.rows[0];
      logger.info(`[Admin Book Approve Analysis] Book ${bookId} 분석 검수 승인 완료 -> ANALYZING_COMPLETE`);

      return handleSuccess({
        message: '도서 분석 결과가 성공적으로 승인되었습니다. 이제 요약 파이프라인을 실행할 수 있습니다.',
        book: updatedBook
      });
    } catch (err) {
      logger.error(`[Admin Book Approve Analysis] 분석 승인 중 오류 발생: ${err.message}`);
      return handleError(err, logger, 'Admin Book Approve Analysis');
    }
  }
});

app.http('approveSummary', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/approve-summary',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Book Approve Summary] 요약 결과 검수 승인 요청 수신 (도서 ID: ${bookId})`);

    try {
      const { user, book } = await verifyBookOwnership(request, bookId);

      // 1. 현재 상태 검증
      if (book.status !== 'SUMMARIZING_COMPLETE') {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Bad Request',
            message: `최종 요약 검수 승인은 SUMMARIZING_COMPLETE 상태의 도서만 가능합니다. (현재 상태: ${book.status})`
          })
        };
      }

      // 2. DB 상태 업데이트 (COMPLETE)
      const result = await dbPool.query(
        `UPDATE books 
         SET status = $1 
         WHERE books_id = $2 AND admin_id = $3 
         RETURNING *`,
        ['COMPLETE', bookId, user.id]
      );

      const updatedBook = result.rows[0];
      logger.info(`[Admin Book Approve Summary] Book ${bookId} 요약 검수 승인 완료 -> COMPLETE`);

      return handleSuccess({
        message: '도서 최종 요약 결과가 성공적으로 승인되어 COMPLETE 상태로 배포되었습니다.',
        book: updatedBook
      });
    } catch (err) {
      logger.error(`[Admin Book Approve Summary] 요약 승인 중 오류 발생: ${err.message}`);
      return handleError(err, logger, 'Admin Book Approve Summary');
    }
  }
});

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
