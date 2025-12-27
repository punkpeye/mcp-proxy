#!/bin/bash

mkdir -p certs
cd certs

# Generate CA private key
openssl genrsa -out ca-key.pem 4096

# Generate CA certificate
openssl req -new -x509 -days 36500 -key ca-key.pem -out ca-cert.pem \
  -subj '/CN=My Test CA/O=Test Org/C=US'

# Generate server private key
openssl genrsa -out server-key.pem 4096

# Create certificate signing request (CSR)
openssl req -new -key server-key.pem -out server-csr.pem \
  -subj '/CN=localhost/O=Test Org/C=US'

# Sign server cert with CA
openssl x509 -req -days 36500 -in server-csr.pem \
  -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -out server-cert.pem

# Generate client private key
openssl genrsa -out client-key.pem 4096

# Create client CSR
openssl req -new -key client-key.pem -out client-csr.pem \
  -subj '/CN=test-client/O=Test Org/C=US'

# Sign client cert with CA
openssl x509 -req -days 36500 -in client-csr.pem \
  -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -out client-cert.pem

echo "Certificates created successfully!"
