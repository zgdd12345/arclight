import arclight_core


def test_package_version_present():
    assert isinstance(arclight_core.__version__, str)
    assert arclight_core.__version__
