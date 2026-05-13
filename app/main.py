import json
import pathlib
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.database import Base, engine, get_db
from app.models import Attendance, Session as SessionModel, Student
from app.schemas import (
    AttendanceOut,
    CheckInRequest,
    DashboardSnapshot,
    SessionCreate,
    SessionOut,
    StudentCreate,
    StudentOut,
)

ROOT = pathlib.Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"


class ConnectionManager:
    def __init__(self) -> None:
        self.active: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active:
            self.active.remove(websocket)

    async def broadcast_json(self, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        data = json.dumps(payload)
        for ws in self.active:
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


def attendance_row(a: Attendance) -> AttendanceOut:
    st = a.student
    return AttendanceOut(
        id=a.id,
        session_id=a.session_id,
        student_id=a.student_id,
        checked_in_at=a.checked_in_at,
        status=a.status,
        note=a.note,
        student_code=st.student_code,
        full_name=st.full_name,
    )


def build_dashboard(db: Session, session_id: int) -> DashboardSnapshot:
    sess = db.get(SessionModel, session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    total = db.scalar(select(func.count()).select_from(Student).where(Student.active == True)) or 0
    present = (
        db.scalar(
            select(func.count())
            .select_from(Attendance)
            .where(Attendance.session_id == session_id)
        )
        or 0
    )
    recent_q = (
        db.execute(
            select(Attendance)
            .options(joinedload(Attendance.student))
            .where(Attendance.session_id == session_id)
            .order_by(Attendance.checked_in_at.desc())
            .limit(25)
        )
        .scalars()
        .all()
    )
    recent = [attendance_row(a) for a in recent_q]
    return DashboardSnapshot(
        session=SessionOut.model_validate(sess),
        present_count=present,
        total_students=total,
        recent=recent,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    with Session(bind=engine) as db:
        if db.scalar(select(func.count()).select_from(Student)) == 0:
            samples = [
                Student(student_code="STU001", full_name="Alex Rivera", email="alex@example.edu"),
                Student(student_code="STU002", full_name="Jordan Lee", email="jordan@example.edu"),
                Student(student_code="STU003", full_name="Sam Patel", email="sam@example.edu"),
                Student(student_code="STU004", full_name="Riley Chen", email="riley@example.edu"),
            ]
            db.add_all(samples)
            db.commit()
        if db.scalar(select(func.count()).select_from(SessionModel)) == 0:
            db.add(
                SessionModel(
                    title="Today's class",
                    description="Live attendance session",
                    starts_at=datetime.utcnow(),
                    active=True,
                )
            )
            db.commit()
    yield


app = FastAPI(title="VajraNetra", description="Smart attendance — live sessions & check-in", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok", "time_utc": datetime.utcnow().isoformat() + "Z"}


@app.get("/api/sessions", response_model=list[SessionOut])
def list_sessions(db: Session = Depends(get_db)):
    rows = db.execute(select(SessionModel).order_by(SessionModel.id.desc())).scalars().all()
    return [SessionOut.model_validate(r) for r in rows]


@app.post("/api/sessions", response_model=SessionOut)
async def create_session(body: SessionCreate, db: Session = Depends(get_db)):
    s = SessionModel(title=body.title, description=body.description)
    db.add(s)
    db.commit()
    db.refresh(s)
    await manager.broadcast_json({"type": "sessions_changed"})
    return SessionOut.model_validate(s)


@app.get("/api/students", response_model=list[StudentOut])
def list_students(db: Session = Depends(get_db)):
    rows = db.execute(select(Student).order_by(Student.full_name)).scalars().all()
    return [StudentOut.model_validate(r) for r in rows]


@app.post("/api/students", response_model=StudentOut)
async def create_student(body: StudentCreate, db: Session = Depends(get_db)):
    if db.scalar(select(Student).where(Student.student_code == body.student_code)):
        raise HTTPException(status_code=400, detail="student_code already exists")
    s = Student(
        student_code=body.student_code.strip(),
        full_name=body.full_name.strip(),
        email=(body.email or "").strip() or None,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    await manager.broadcast_json({"type": "students_changed"})
    return StudentOut.model_validate(s)


@app.get("/api/dashboard/{session_id}", response_model=DashboardSnapshot)
def dashboard(session_id: int, db: Session = Depends(get_db)):
    return build_dashboard(db, session_id)


@app.post("/api/check-in", response_model=AttendanceOut)
async def check_in(body: CheckInRequest, db: Session = Depends(get_db)):
    sess = db.get(SessionModel, body.session_id)
    if not sess or not sess.active:
        raise HTTPException(status_code=404, detail="Session not found or inactive")
    code = body.student_code.strip()
    student = db.scalar(select(Student).where(Student.student_code == code, Student.active == True))
    if not student:
        raise HTTPException(status_code=404, detail="Unknown or inactive student code")
    existing = db.scalar(
        select(Attendance).where(
            Attendance.session_id == body.session_id,
            Attendance.student_id == student.id,
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="Already checked in for this session")
    row = Attendance(session_id=body.session_id, student_id=student.id, status="present")
    db.add(row)
    db.commit()
    db.refresh(row)
    row = db.execute(
        select(Attendance).options(joinedload(Attendance.student)).where(Attendance.id == row.id)
    ).scalar_one()
    snap = build_dashboard(db, body.session_id)
    await manager.broadcast_json(
        {
            "type": "check_in",
            "attendance": attendance_row(row).model_dump(mode="json"),
            "dashboard": snap.model_dump(mode="json"),
        }
    )
    return attendance_row(row)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


app.mount("/assets", StaticFiles(directory=str(STATIC)), name="assets")


@app.get("/")
def index_page():
    return FileResponse(str(STATIC / "index.html"))
