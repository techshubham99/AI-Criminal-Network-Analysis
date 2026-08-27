"""Dataset summary endpoint."""
from fastapi import APIRouter, Depends

from app.api.deps import get_dataset
from app.repositories.dataset import DatasetRepository
from app.schemas.summary import DataSummaryResponse
from app.services.data_service import build_summary

router = APIRouter()


@router.get("/summary", response_model=DataSummaryResponse, summary="Dataset load & integrity summary")
def data_summary(repo: DatasetRepository = Depends(get_dataset)) -> DataSummaryResponse:
    """Descriptive counts, integrity report, and profile statistics for the loaded dataset."""
    return build_summary(repo)
