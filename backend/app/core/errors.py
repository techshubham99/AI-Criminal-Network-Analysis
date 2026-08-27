"""Structured error handling.

Every error response has a consistent envelope::

    {"error": {"code": "...", "message": "...", "detail": ...}}
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("app.errors")


class AppError(Exception):
    """Base class for application errors with a stable error code."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        detail: Optional[Any] = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        self.detail = detail
        super().__init__(message)


class NotFoundError(AppError):
    def __init__(self, resource: str, identifier: Any) -> None:
        super().__init__(
            status_code=404,
            code="not_found",
            message=f"{resource} '{identifier}' not found",
            detail={"resource": resource, "id": identifier},
        )


class ServiceUnavailableError(AppError):
    def __init__(self, message: str) -> None:
        super().__init__(status_code=503, code="service_unavailable", message=message)


class BadRequestError(AppError):
    """A well-formed-but-invalid request, e.g. source == target in a path query."""

    def __init__(self, message: str, detail: Any = None) -> None:
        super().__init__(status_code=400, code="bad_request", message=message, detail=detail)


def _envelope(code: str, message: str, detail: Any = None) -> dict:
    return {"error": {"code": code, "message": message, "detail": detail}}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope(exc.code, exc.message, exc.detail),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=_envelope(
                "validation_error",
                "Request validation failed",
                jsonable_encoder(exc.errors()),
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope("http_error", str(exc.detail), None),
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error: %s", type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content=_envelope("internal_error", "Internal server error", None),
        )
