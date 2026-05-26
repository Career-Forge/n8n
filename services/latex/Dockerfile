FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install TeX Live + Python + pip in one layer
RUN apt-get update && apt-get install -y \
    texlive-latex-base \
    texlive-latex-extra \
    texlive-fonts-recommended \
    texlive-fonts-extra \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install flask

WORKDIR /app
COPY app.py .

EXPOSE 5679
CMD ["python3", "app.py"]