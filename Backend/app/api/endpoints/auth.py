from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import create_access_token, verify_access_token, verify_password
from app.models.user import User

router = APIRouter(prefix="/auth", tags=["Authentication & Authorization"])
security_scheme = HTTPBearer(auto_error=False)


class LoginRequest(BaseModel):
    username: str
    password: str


class UserResponse(BaseModel):
    username: str
    role: str
    displayName: str
    token: str


class UserPublicInfo(BaseModel):
    username: str
    role: str
    displayName: str


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security_scheme),
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db)
) -> User:
    """
    Extracts and cryptographically verifies the bearer token.
    Validates HMAC-SHA256 signature, expiry, and matches against the database table.
    Ensures role cannot be forged or tampered with.
    """
    raw_token = None
    if credentials and credentials.credentials:
        raw_token = credentials.credentials
    elif authorization and authorization.lower().startswith("bearer "):
        raw_token = authorization[7:].strip()

    if not raw_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token is missing. Please log in."
        )

    try:
        payload = verify_access_token(raw_token)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid or tampered authentication token: {str(e)}"
        )

    username = payload.get("sub")
    token_role = payload.get("role")
    if not username or not token_role:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed token claims."
        )

    user = db.query(User).filter(User.username == username, User.is_active == True).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found or disabled."
        )

    # Cryptographic integrity check against authoritative database state:
    # If someone tried to manipulate their role or use an old token with a superseded role,
    # strictly reject the request.
    if user.role != token_role:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Role mismatch: token role does not match authoritative database record."
        )

    return user


def require_operator(current_user: User = Depends(get_current_user)) -> User:
    """Restricts access strictly to active Operators."""
    if current_user.role != "OPERATOR":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Forbidden: Role '{current_user.role}' is not authorized for this action. Operator access required."
        )
    return current_user


def require_commander(current_user: User = Depends(get_current_user)) -> User:
    """Restricts access strictly to active Commanders."""
    if current_user.role != "COMMANDER":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Forbidden: Role '{current_user.role}' is not authorized for this action. Commander access required."
        )
    return current_user


def require_authenticated_user(current_user: User = Depends(get_current_user)) -> User:
    """Allows any authenticated Operator or Commander."""
    return current_user


@router.post("/login", response_model=UserResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    """
    Authenticates a user against the database table using PBKDF2-HMAC-SHA256 password verification.
    Issues a cryptographically signed HMAC-SHA256 bearer token.
    """
    user = db.query(User).filter(User.username == payload.username, User.is_active == True).first()
    if not user or not verify_password(payload.password, user.password_hash, user.salt):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )

    token = create_access_token(username=user.username, role=user.role)

    return UserResponse(
        username=user.username,
        role=user.role,
        displayName=user.display_name,
        token=token
    )


@router.get("/me", response_model=UserPublicInfo)
def get_current_user_profile(current_user: User = Depends(get_current_user)):
    """Returns the authenticated user's profile and verified database role."""
    return UserPublicInfo(
        username=current_user.username,
        role=current_user.role,
        displayName=current_user.display_name
    )


@router.get("/users", response_model=List[UserPublicInfo])
def get_available_users(db: Session = Depends(get_db)):
    """Returns registered users and their roles from the database table (never exposes hashes/salts)."""
    users = db.query(User).filter(User.is_active == True).order_by(User.id.asc()).all()
    return [
        UserPublicInfo(
            username=u.username,
            role=u.role,
            displayName=u.display_name
        )
        for u in users
    ]
