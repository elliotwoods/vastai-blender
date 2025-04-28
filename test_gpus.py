import torch

def test_all_gpus():
    if not torch.cuda.is_available():
        print("❌ CUDA is not available at all!")
        return

    num_gpus = torch.cuda.device_count()
    print(f"🔎 Found {num_gpus} CUDA device(s).\n")

    for i in range(num_gpus):
        try:
            print(f"🎯 Testing GPU {i}: {torch.cuda.get_device_name(i)}")
            device = torch.device(f'cuda:{i}')
            # Allocate a big random matrix
            x = torch.randn((5000, 5000), device=device)
            # Do a matrix multiplication
            y = torch.matmul(x, x)
            # Force sync to ensure computation actually happened
            torch.cuda.synchronize(device)
            print(f"✅ GPU {i} passed! (Result shape: {y.shape})\n")
        except Exception as e:
            print(f"❌ GPU {i} failed with error: {e}\n")

if __name__ == "__main__":
    test_all_gpus()
