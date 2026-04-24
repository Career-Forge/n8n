FROM blang/latex:ubuntu

# blang/latex already has full TeX Live + Ubuntu
# Just add Python + Flask

RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install flask

WORKDIR /app
COPY app.py .

EXPOSE 5679
CMD ["python3", "app.py"]
