export function handleSuccess(body, status = 200) {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

export function handleError(err, logger, prefix) {
  if (err.status) {
    return {
      status: err.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(err.body)
    };
  }
  logger.error(`[${prefix}] 오류: ${err.message}`);
  return {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Internal Server Error', message: err.message })
  };
}
