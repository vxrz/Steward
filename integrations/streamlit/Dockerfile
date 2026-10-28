# Streamlit example app on Steward's read-only API.
#   docker build -t steward-streamlit .
# No secrets in the image: mount secrets.toml at run time (compose.snippet.yml).
FROM python:3.13.15-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false \
    STREAMLIT_SERVER_HEADLESS=true \
    STREAMLIT_SERVER_ADDRESS=0.0.0.0 \
    STREAMLIT_SERVER_PORT=8501 \
    STREAMLIT_CLIENT_SHOW_ERROR_DETAILS=none \
    STREAMLIT_CLIENT_TOOLBAR_MODE=viewer

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-compile -r requirements.txt

# Only the app files – never .streamlit/secrets.toml (also excluded in .dockerignore)
COPY app.py steward.py ./
COPY pages/ pages/

USER app
EXPOSE 8501

# Under a base path (STREAMLIT_SERVER_BASE_URL_PATH) the health endpoint moves below it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["python", "-c", "import os, urllib.request; p = os.environ.get('STREAMLIT_SERVER_BASE_URL_PATH', '').strip('/'); urllib.request.urlopen('http://127.0.0.1:8501/' + (p + '/' if p else '') + '_stcore/health', timeout=4)"]

CMD ["streamlit", "run", "app.py"]
