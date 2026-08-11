from TTS.tts.models.xtts import Xtts
import inspect
print(inspect.signature(Xtts.inference))
print(inspect.signature(Xtts.inference_stream))
