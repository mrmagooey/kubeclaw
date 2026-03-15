FROM alpine:latest

# Install jq for JSON processing
RUN apk add --no-cache jq

# Create workspace directories
RUN mkdir -p /workspace/input /workspace/output

# Copy the echo script
COPY echo.sh /usr/local/bin/echo.sh
RUN chmod +x /usr/local/bin/echo.sh

# Default command runs the echo script
CMD ["/usr/local/bin/echo.sh"]
