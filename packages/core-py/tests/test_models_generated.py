def test_generated_models_import_key_classes():
    from arclight_core.protocol import models

    assert hasattr(models, "ArcCommand")
    assert hasattr(models, "ArcAck")
    assert hasattr(models, "CapabilityProfile")
    assert hasattr(models, "TurnCompleted")
