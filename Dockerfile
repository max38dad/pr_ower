FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Non forziamo l'EXPOSE a 8080, lasciamo che sia dinamico
# EXPOSE 8080

CMD ["python", "app.py"]
