FROM python:3.12.16-slim

RUN pip install --no-cache-dir fastmcp==4.1.4

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8000
CMD ["python", "/app/server.py"]
