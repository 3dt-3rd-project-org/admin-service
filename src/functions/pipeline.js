import { app } from '@azure/functions';
import { dbPool } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { verifyBookOwnership } from '../shared/authHelper.js';
import { handleSuccess, handleError } from '../shared/responseHelper.js';

// 1. 도서 분석 파이프라인 기동
app.http('analyzeBook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/analyze',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Book Analyze] 분석 기동 요청 수신 (도서 ID: ${bookId})`);

    try {
      const { user, book } = await verifyBookOwnership(request, bookId);

      // 현재 상태 검증
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

      // DB 상태 업데이트 (ANALYZING)
      const result = await dbPool.query(
        `UPDATE books 
         SET status = $1 
         WHERE books_id = $2 AND admin_id = $3 
         RETURNING *`,
        ['ANALYZING', bookId, user.id]
      );

      const updatedBook = result.rows[0];

      // Logic App 호출 (ADF 파이프라인 구동)
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

// 2. 도서 요약 파이프라인 기동
app.http('summarizeBook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/summary',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Book Summary] 요약 기동 요청 수신 (도서 ID: ${bookId})`);

    try {
      const { user, book } = await verifyBookOwnership(request, bookId);

      // 현재 상태 검증
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

      // DB 상태 업데이트 (SUMMARIZING)
      const result = await dbPool.query(
        `UPDATE books 
         SET status = $1 
         WHERE books_id = $2 AND admin_id = $3 
         RETURNING *`,
        ['SUMMARIZING', bookId, user.id]
      );

      const updatedBook = result.rows[0];

      // Logic App 호출 (ADF 파이프라인 구동)
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

// 3. 분석 결과 수정 및 승인
app.http('approveAnalysis', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/approve-analysis',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Book Approve Analysis] 분석 결과 수정 및 승인 요청 수신 (도서 ID: ${bookId})`);

    try {
      const { user, book } = await verifyBookOwnership(request, bookId);

      // 현재 상태 검증
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

      const reqBody = await request.json();
      const { characters, relations, events } = reqBody;
      const charList = characters || [];
      const relList = relations || [];
      const eventList = events || [];

      logger.info(`[Admin Book Approve Analysis] 일괄 반영 데이터 건수 - 인물: ${charList.length}건, 관계: ${relList.length}건, 사건: ${eventList.length}건`);

      // 단일 클라이언트를 획득하여 트랜잭션 수행
      const client = await dbPool.connect();
      try {
        await client.query('BEGIN');

        // 1) 인물 일괄 수정
        for (const char of charList) {
          if (!char.character_id) {
            throw new Error(`인물 수정 실패: character_id가 누락되었습니다.`);
          }
          await client.query(
            'CALL readpoint.sp_upsert_character($1, $2, $3, $4, $5)',
            [char.character_id, bookId, char.character_name, char.role, char.description]
          );
        }

        // 2) 관계 일괄 수정 (지정된 열만 수정 허용)
        for (const rel of relList) {
          if (!rel.relationship_change_id) {
            throw new Error(`관계 수정 실패: relationship_change_id가 누락되었습니다.`);
          }
          const existRes = await client.query(
            'SELECT * FROM readpoint.relationship_change WHERE relationship_change_id = $1 AND books_id = $2',
            [rel.relationship_change_id, bookId]
          );
          if (existRes.rows.length === 0) {
            throw new Error(`관계 수정 실패: 존재하지 않는 관계 ID입니다. (relationship_change_id: ${rel.relationship_change_id})`);
          }
          const existing = existRes.rows[0];

          const relation = rel.relation !== undefined ? rel.relation : existing.relation;
          const change_summary = rel.change_summary !== undefined ? rel.change_summary : existing.change_summary;
          const importance_score = rel.importance_score !== undefined ? parseFloat(rel.importance_score) : (existing.importance_score !== null ? parseFloat(existing.importance_score) : null);
          const is_core_relation = rel.is_core_relation !== undefined ? !!rel.is_core_relation : existing.is_core_relation;

          await client.query(
            `SELECT readpoint.sp_upsert_relation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              rel.relationship_change_id,
              bookId,
              existing.chapter_id,
              existing.related_event_id,
              existing.source_character_id,
              existing.target_character_id,
              relation,
              change_summary,
              existing.evidence,
              existing.start_paragraph_order,
              existing.end_paragraph_order,
              existing.relation_category,
              importance_score,
              is_core_relation
            ]
          );
        }

        // 3) 사건 일괄 수정 (지정된 열만 수정 허용)
        for (const ev of eventList) {
          if (!ev.event_id) {
            throw new Error(`사건 수정 실패: event_id가 누락되었습니다.`);
          }
          const existRes = await client.query(
            'SELECT * FROM readpoint.event WHERE event_id = $1 AND books_id = $2',
            [ev.event_id, bookId]
          );
          if (existRes.rows.length === 0) {
            throw new Error(`사건 수정 실패: 존재하지 않는 사건 ID입니다. (event_id: ${ev.event_id})`);
          }
          const existing = existRes.rows[0];

          const short_title = ev.short_title !== undefined ? ev.short_title : existing.short_title;
          const summary = ev.summary !== undefined ? ev.summary : existing.summary;
          const event_type = ev.event_type !== undefined ? ev.event_type : existing.event_type;
          const importance_score = ev.importance_score !== undefined ? parseFloat(ev.importance_score) : (existing.importance_score !== null ? parseFloat(existing.importance_score) : null);
          const is_core_event = ev.is_core_event !== undefined ? !!ev.is_core_event : existing.is_core_event;

          await client.query(
            `SELECT readpoint.sp_upsert_event($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              ev.event_id,
              bookId,
              existing.chapter_id,
              existing.event_order,
              summary,
              existing.evidence,
              existing.start_paragraph_id,
              existing.end_paragraph_id,
              short_title,
              event_type,
              importance_score,
              is_core_event,
              existing.is_sensitive
            ]
          );
        }

        // 4) DB 상태 업데이트 (ANALYZING_COMPLETE)
        const updateResult = await client.query(
          `UPDATE books 
           SET status = $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE books_id = $2 AND admin_id = $3 
           RETURNING *`,
          ['ANALYZING_COMPLETE', bookId, user.id]
        );

        const updatedBook = updateResult.rows[0];

        await client.query('COMMIT');
        logger.info(`[Admin Book Approve Analysis] Book ${bookId} 일괄 수정 및 분석 승인 완료 -> ANALYZING_COMPLETE`);

        return handleSuccess({
          message: '도서 데이터 수정 및 분석 결과가 성공적으로 승인되었습니다. 이제 요약 파이프라인을 실행할 수 있습니다.',
          book: updatedBook
        });
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
    } catch (err) {
      logger.error(`[Admin Book Approve Analysis] 일괄 수정 및 분석 승인 중 오류 발생: ${err.message}`);
      return handleError(err, logger, 'Admin Book Approve Analysis');
    }
  }
});

// 4. 요약 결과 검수 승인
app.http('approveSummary', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/approve-summary',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Book Approve Summary] 요약 결과 검수 승인 요청 수신 (도서 ID: ${bookId})`);

    try {
      const { user, book } = await verifyBookOwnership(request, bookId);

      // 현재 상태 검증
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

      let reqBody = {};
      try {
        reqBody = await request.json();
      } catch (jsonErr) {
        logger.info('[Admin Book Approve Summary] 요청 본문(body)이 비어있거나 JSON 형식이 아닙니다. 단순 승인 처리를 진행합니다.');
      }

      const { summaries } = reqBody;
      let updatedBook;

      if (summaries && Array.isArray(summaries) && summaries.length > 0) {
        logger.info(`[Admin Book Approve Summary] 요약 수정 건수: ${summaries.length}건. 일괄 적재 및 승인 처리를 진행합니다.`);

        const client = await dbPool.connect();
        try {
          await client.query('BEGIN');

          for (const item of summaries) {
            if (item.progress_summary_id === undefined || item.progress_summary_id === null) {
              throw new Error('요약 수정 실패: progress_summary_id가 누락되었습니다.');
            }
            if (item.summary_3line === undefined || item.summary_3line === null) {
              throw new Error('요약 수정 실패: summary_3line 내용이 누락되었습니다.');
            }

            const updateRes = await client.query(
              `UPDATE readpoint.progress_summary
               SET summary_3line = $1, updated_at = CURRENT_TIMESTAMP
               WHERE progress_summary_id = $2 AND books_id = $3
               RETURNING *`,
              [item.summary_3line, item.progress_summary_id, bookId]
            );

            if (updateRes.rows.length === 0) {
              throw new Error(`요약 수정 실패: 존재하지 않는 요약 ID이거나 해당 도서의 요약이 아닙니다. (ID: ${item.progress_summary_id})`);
            }
          }

          // DB 상태 업데이트 (COMPLETE)
          const result = await client.query(
            `UPDATE books 
             SET status = $1, updated_at = CURRENT_TIMESTAMP
             WHERE books_id = $2 AND admin_id = $3 
             RETURNING *`,
            ['COMPLETE', bookId, user.id]
          );

          updatedBook = result.rows[0];
          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK');
          throw txErr;
        } finally {
          client.release();
        }
      } else {
        logger.info('[Admin Book Approve Summary] 수정 요청된 요약이 없으므로 상태만 COMPLETE로 즉시 변경합니다.');
        const result = await dbPool.query(
          `UPDATE books 
           SET status = $1, updated_at = CURRENT_TIMESTAMP
           WHERE books_id = $2 AND admin_id = $3 
           RETURNING *`,
          ['COMPLETE', bookId, user.id]
        );
        updatedBook = result.rows[0];
      }

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
