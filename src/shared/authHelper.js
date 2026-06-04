import jwt from 'jsonwebtoken';
import { dbPool } from '../config/db.js';
import { logger } from '../utils/logger.js';

const JWT_SECRET = process.env.JWT_SECRET;

export function authenticateToken(request) {
  const authHeader = request.headers.get('authorization');
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    throw {
      status: 401,
      body: { error: 'Unauthorized', message: '요청 헤더에 Bearer 토큰이 존재하지 않습니다.' }
    };
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role
    };
  } catch (err) {
    throw {
      status: 403,
      body: { error: 'Forbidden', message: '유효하지 않거나 만료된 토큰입니다.' }
    };
  }
}

export function requireAdmin(request) {
  const user = authenticateToken(request);

  if (user.role !== 'ADMIN') {
    throw {
      status: 403,
      body: { error: 'Forbidden', message: '관리자 전용 경로입니다. 접근 권한이 없습니다.' }
    };
  }

  return user;
}

export async function verifyBookOwnership(request, bookIdParam) {
  const user = requireAdmin(request);
  const bookId = parseInt(bookIdParam, 10);

  if (isNaN(bookId)) {
    throw {
      status: 400,
      body: { error: 'Bad Request', message: '유효한 도서 식별자(id)가 요청에 존재하지 않습니다.' }
    };
  }

  try {
    const result = await dbPool.query(
      'SELECT * FROM books WHERE books_id = $1 AND admin_id = $2',
      [bookId, user.id]
    );

    if (result.rows.length === 0) {
      throw {
        status: 403,
        body: { error: 'Forbidden', message: '해당 도서 자원에 대한 접근 권한이 없거나 도서가 존재하지 않습니다.' }
      };
    }

    return {
      user,
      book: result.rows[0]
    };
  } catch (err) {
    if (err.status) throw err;

    logger.error(`[Auth Helper] 소유권 검증 데이터베이스 조회 오류: ${err.message}`);
    throw {
      status: 500,
      body: { error: 'Internal Server Error', message: '소유권 검증 도중 데이터베이스 오류가 발생했습니다.' }
    };
  }
}
