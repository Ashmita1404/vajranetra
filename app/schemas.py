from datetime import datetime

from pydantic import BaseModel, Field


class StudentCreate(BaseModel):
    student_code: str = Field(..., min_length=1, max_length=64)
    full_name: str = Field(..., min_length=1, max_length=255)
    email: str | None = None


class StudentOut(BaseModel):
    id: int
    student_code: str
    full_name: str
    email: str | None
    active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class SessionCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    description: str | None = None


class SessionOut(BaseModel):
    id: int
    title: str
    description: str | None
    starts_at: datetime
    ends_at: datetime | None
    active: bool

    model_config = {"from_attributes": True}


class CheckInRequest(BaseModel):
    student_code: str = Field(..., min_length=1, max_length=64)
    session_id: int


class AttendanceOut(BaseModel):
    id: int
    session_id: int
    student_id: int
    checked_in_at: datetime
    status: str
    note: str | None
    student_code: str
    full_name: str

    model_config = {"from_attributes": True}


class DashboardSnapshot(BaseModel):
    session: SessionOut
    present_count: int
    total_students: int
    recent: list[AttendanceOut]
