from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from typing import Dict, Any, List

router = APIRouter(prefix="/auth", tags=["Authentication & Authorization"])


class LoginRequest(BaseModel):
    username: str
    password: str


class UserResponse(BaseModel):
    username: str
    role: str
    displayName: str
    token: str


# Pre-registered demo accounts for ORION
REGISTERED_USERS: Dict[str, Dict[str, str]] = {
    "operator_demo": {
        "password": "123",
        "role": "OPERATOR",
        "displayName": "Operator Demo",
    },
    "commander_demo": {
        "password": "123",
        "role": "COMMANDER",
        "displayName": "Commander Demo",
    },
}


@router.post("/login", response_model=UserResponse)
def login(payload: LoginRequest):
    """
    Authenticates an operator or commander.
    Pre-registered demo accounts:
      - operator_demo / 123 (OPERATOR)
      - commander_demo / 123 (COMMANDER)
    """
    user = REGISTERED_USERS.get(payload.username)
    if not user or user["password"] != payload.password:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )
    return UserResponse(
        username=payload.username,
        role=user["role"],
        displayName=user["displayName"],
        token=f"orion-token-{payload.username}"
    )


@router.get("/users")
def get_available_users() -> List[Dict[str, str]]:
    """Returns the registered demo users with role descriptions."""
    return [
        {
            "username": uname,
            "role": udata["role"],
            "displayName": udata["displayName"]
        }
        for uname, udata in REGISTERED_USERS.items()
    ]
