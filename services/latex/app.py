from flask import Flask, request, send_file, jsonify
import subprocess
import tempfile
import os
import logging

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "careerforge-latex"})

@app.route('/compile', methods=['POST'])
def compile_latex():
    try:
        tex_content = request.get_data(as_text=True)
        if not tex_content:
            return jsonify({"error": "No LaTeX content provided"}), 400

        with tempfile.TemporaryDirectory() as tmpdir:
            tex_file = os.path.join(tmpdir, 'resume.tex')
            pdf_file = os.path.join(tmpdir, 'resume.pdf')

            with open(tex_file, 'w', encoding='utf-8') as f:
                f.write(tex_content)

            # Run pdflatex twice for proper formatting
            for run in range(2):
                result = subprocess.run(
                    ['pdflatex', '-interaction=nonstopmode',
                     '-output-directory', tmpdir, tex_file],
                    capture_output=True,
                    timeout=60
                )
                app.logger.info(f"pdflatex run {run+1} exit code: {result.returncode}")

            if os.path.exists(pdf_file) and os.path.getsize(pdf_file) > 0:
                app.logger.info(f"PDF generated: {os.path.getsize(pdf_file)} bytes")
                return send_file(
                    pdf_file,
                    mimetype='application/pdf',
                    as_attachment=True,
                    download_name='resume.pdf'
                )
            else:
                stdout = result.stdout.decode('utf-8', errors='replace')
                stderr = result.stderr.decode('utf-8', errors='replace')
                app.logger.error(f"PDF generation failed.\nSTDOUT: {stdout[-2000:]}\nSTDERR: {stderr[-500:]}")
                return jsonify({
                    "error": "PDF compilation failed",
                    "log": stdout[-2000:]
                }), 500

    except subprocess.TimeoutExpired:
        return jsonify({"error": "Compilation timed out"}), 504
    except Exception as e:
        app.logger.exception("Unexpected error")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5679, debug=False)
