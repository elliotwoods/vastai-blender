import bpy

# Execute all text blocks that start with "startup"
for text in bpy.data.texts:
	if text.name.lower().startswith("startup"):
		print(f"Excecuting startup script {text.name}")
		exec(text.as_string(), globals())