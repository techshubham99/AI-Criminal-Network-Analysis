"""Shared schemas: health, pagination envelope, root."""
from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class HealthResponse(BaseModel):
    status: str
    app: str
    version: str
    phase: str
    environment: str
    dataset_loaded: bool


class RootResponse(BaseModel):
    app: str
    version: str
    phase: str
    docs: str
    health: str
    api_base: str


class PageMeta(BaseModel):
    page: int
    page_size: int
    total: int
    total_pages: int
    has_next: bool
    has_prev: bool


class Page(BaseModel, Generic[T]):
    items: list[T]
    meta: PageMeta


def build_meta(page: int, page_size: int, total: int) -> PageMeta:
    total_pages = (total + page_size - 1) // page_size if page_size else 0
    return PageMeta(
        page=page,
        page_size=page_size,
        total=total,
        total_pages=total_pages,
        has_next=page * page_size < total,
        has_prev=page > 1,
    )
