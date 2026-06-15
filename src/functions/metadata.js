import { app } from '@azure/functions';
import { dbPool } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { verifyBookOwnership } from '../shared/authHelper.js';
import { handleSuccess, handleError } from '../shared/responseHelper.js';

// 1. 책 인물 목록 조회
app.http('getCharacters', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/characters',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Get Characters] 책 인물 목록 조회 요청 수신 (도서 ID: ${bookId})`);
    try {
      await verifyBookOwnership(request, bookId);

      const result = await dbPool.query(
        'SELECT * FROM readpoint.sp_get_characters($1)',
        [bookId]
      );

      logger.info(`[Admin Get Characters] 책 ${bookId} 인물 목록 조회 완료 (조회 수: ${result.rows.length}개)`);
      return handleSuccess({
        message: '인물 목록을 조회했습니다.',
        characters: result.rows
      });
    } catch (err) {
      return handleError(err, logger, 'Admin Get Characters');
    }
  }
});

// 2. 책 인물 관계 목록 조회
app.http('getRelations', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/relations',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Get Relations] 책 인물 관계 목록 조회 요청 수신 (도서 ID: ${bookId})`);
    try {
      await verifyBookOwnership(request, bookId);

      const result = await dbPool.query(
        'SELECT * FROM readpoint.sp_get_relations($1)',
        [bookId]
      );

      logger.info(`[Admin Get Relations] 책 ${bookId} 인물 관계 목록 조회 완료 (조회 수: ${result.rows.length}개)`);
      return handleSuccess({
        message: '인물 관계 목록을 조회했습니다.',
        relations: result.rows
      });
    } catch (err) {
      return handleError(err, logger, 'Admin Get Relations');
    }
  }
});

// 3. 책 사건 목록 조회
app.http('getEvents', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/events',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Get Events] 책 사건 목록 조회 요청 수신 (도서 ID: ${bookId})`);
    try {
      await verifyBookOwnership(request, bookId);

      const result = await dbPool.query(
        'SELECT * FROM readpoint.sp_get_events($1)',
        [bookId]
      );

      logger.info(`[Admin Get Events] 책 ${bookId} 사건 목록 조회 완료 (조회 수: ${result.rows.length}개)`);
      return handleSuccess({
        message: '사건 목록을 조회했습니다.',
        events: result.rows
      });
    } catch (err) {
      return handleError(err, logger, 'Admin Get Events');
    }
  }
});

// 4. 책 요약 목록 조회
app.http('getSummaries', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'adm/books/{id}/summaries',
  handler: async (request, context) => {
    const bookId = request.params.id;
    logger.info(`[Admin Get Summaries] 책 요약 목록 조회 요청 수신 (도서 ID: ${bookId})`);
    try {
      await verifyBookOwnership(request, bookId);

      const queryStr = `
        SELECT 
            ps.progress_summary_id,
            ps.summary_3line,
            c.chapter_order,
            p.paragraph_order
        FROM readpoint.progress_summary ps
        JOIN readpoint.chapter c ON ps.chapter_id = c.chapter_id
        JOIN readpoint.paragraph p ON ps.end_paragraph_id = p.paragraph_id
        WHERE ps.books_id = $1
        ORDER BY c.chapter_order ASC, p.paragraph_order ASC;
      `;

      const result = await dbPool.query(queryStr, [bookId]);

      logger.info(`[Admin Get Summaries] 책 ${bookId} 요약 목록 조회 완료 (조회 수: ${result.rows.length}개)`);
      return handleSuccess({
        message: '요약 목록을 조회했습니다.',
        summaries: result.rows.map(row => ({
          progress_summary_id: parseInt(row.progress_summary_id, 10),
          summary_3line: row.summary_3line,
          chapter_order: row.chapter_order,
          paragraph_order: row.paragraph_order
        }))
      });
    } catch (err) {
      return handleError(err, logger, 'Admin Get Summaries');
    }
  }
});
