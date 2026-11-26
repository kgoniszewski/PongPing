import ezdxf, math, sys
out = sys.argv[1]
# 1) płyta z zaokrągleniami (bulge), otworami, fasolką z łuków ARC + LINE
doc = ezdxf.new('R2018'); doc.header['$INSUNITS'] = 4; msp = doc.modelspace()
b = math.tan(math.radians(90)/4)
msp.add_lwpolyline([(10,0,0,0,0),(190,0,0,0,b),(200,10,0,0,0),(200,90,0,0,b),(190,100,0,0,0),(10,100,0,0,b),(0,90,0,0,0),(0,10,0,0,b)], format='xyseb', close=True)
msp.add_circle((40,50), 10)
msp.add_line((120,40),(160,40)); msp.add_arc((160,50),10,-90,90); msp.add_line((160,60),(120,60)); msp.add_arc((120,50),10,90,270)
msp.add_text('OPIS', dxfattribs={'insert':(50,80)})
msp.add_linear_dim(base=(0,-20), p1=(0,0), p2=(200,0)).render()
doc.saveas(f'{out}/plyta.dxf')
# 2) dwa różne detale w jednym pliku + splajn + elipsa + otwarta linia (grawer)
doc = ezdxf.new('R2010'); msp = doc.modelspace()
msp.add_spline_control_frame([(0,0),(100,-30),(200,0),(200,100),(100,130),(0,100),(0,0)])
s = msp.add_spline(fit_points=None); 
msp.add_ellipse((400,50), major_axis=(80,0), ratio=0.5)
msp.add_circle((400,50), 15)
msp.add_line((380,50),(420,50))
doc.saveas(f'{out}/splajn_elipsa.dxf')
# 3) bloki: wstawienia z obrotem, lustrem i skalą, w calach
doc = ezdxf.new('R2013'); doc.header['$INSUNITS'] = 1; msp = doc.modelspace()
blk = doc.blocks.new('ZAWIAS', base_point=(1,1))
blk.add_lwpolyline([(1,1),(5,1),(5,3),(3,3),(3,4),(1,4)], close=True)
blk.add_circle((2,2), 0.25)
msp.add_blockref('ZAWIAS', (0,0), dxfattribs={'rotation': 30})
msp.add_blockref('ZAWIAS', (10,0), dxfattribs={'xscale': -1})
msp.add_blockref('ZAWIAS', (20,0), dxfattribs={'xscale': 2, 'yscale': 2})
doc.saveas(f'{out}/bloki_cale.dxf')
# 4) OCS z normalną (0,0,-1): łuki i lwpolyline
doc = ezdxf.new('R2018'); doc.header['$INSUNITS'] = 4; msp = doc.modelspace()
ex = (0,0,-1)
# półkole + cięciwa (w WCS x od -100..0) budowane w OCS
msp.add_arc((50,0), 50, 0, 180, dxfattribs={'extrusion': ex})
msp.add_line((0,0),(-100,0))
msp.add_lwpolyline([(200,0),(260,0),(260,40),(200,40)], close=True, dxfattribs={'extrusion': ex})
doc.saveas(f'{out}/ocs.dxf')
# oczekiwane pola
print('plyta', 200*100 - (4-math.pi)*100 - math.pi*100 - (40*20+math.pi*100))
print('polkole', math.pi*50*50/2, 'prostokat', 60*40)
print('zawias [mm2]', (4*2+2*1)*25.4**2 - math.pi*0.25**2*25.4**2, 'x4 skala2:', 4*((4*2+2*1)*25.4**2 - math.pi*0.25**2*25.4**2))
print('elipsa', math.pi*80*40 - math.pi*225)
